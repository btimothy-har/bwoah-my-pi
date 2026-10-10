import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import * as environment from "@oh-my-pi/pi-utils/env";
import { $ } from "bun";
import {
	type ExecutionBindingInvalidReason,
	type ExecutionBindingResolution,
	resolveExecutionBinding,
} from "../../src/bwoah/execution-workspace/binding";
import { Settings } from "../../src/config/settings";

let root: TempDir;
let previousExecutionWorkspaceEnv: string | undefined;

beforeEach(async () => {
	previousExecutionWorkspaceEnv = Bun.env.BWOAH_EXECUTION_WORKSPACE;
	delete Bun.env.BWOAH_EXECUTION_WORKSPACE;
	root = await TempDir.create("@execution-binding-");
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (previousExecutionWorkspaceEnv === undefined) delete Bun.env.BWOAH_EXECUTION_WORKSPACE;
	else Bun.env.BWOAH_EXECUTION_WORKSPACE = previousExecutionWorkspaceEnv;
	await root.remove();
});

async function directory(name: string): Promise<string> {
	const cwd = root.join(name);
	await fs.mkdir(cwd, { recursive: true });
	return cwd;
}

async function repository(name = "home", commit = true): Promise<string> {
	const cwd = root.join(name);
	await $`git init --initial-branch=main ${cwd}`.quiet();
	if (commit) {
		await $`git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=Test -c user.email=test@example.test commit --allow-empty -m initial`
			.cwd(cwd)
			.quiet();
	}
	return cwd;
}

async function worktree(home: string): Promise<string> {
	const execution = root.join("execution");
	await $`git -c core.hooksPath=/dev/null worktree add -b execution ${execution}`.cwd(home).quiet();
	return execution;
}

async function linkedFixture(): Promise<{ home: string; execution: string; commondir: string }> {
	const home = await repository();
	const execution = await worktree(home);
	return { home, execution, commondir: path.join(vcs.gitInfo(execution)!.gitDir, "commondir") };
}

function inspect(home: string, executionCwd?: unknown): Promise<ExecutionBindingResolution> {
	return resolveExecutionBinding(
		{ cwd: home, executionCwd },
		Settings.isolated({ "bwoah.executionWorkspace.enabled": true }),
	);
}

async function expectInvalid(
	home: string,
	executionCwd: unknown,
	reason: ExecutionBindingInvalidReason,
): Promise<void> {
	expect(await inspect(home, executionCwd)).toEqual({ kind: "invalid", reason });
}

function forbidInspection(): () => void {
	const directoryProbe = vi.spyOn(dirs, "directoryIsEnterable").mockResolvedValue(false);
	const stat = vi.spyOn(fs, "stat").mockRejectedValue(new Error("unexpected stat"));
	const git = vi.spyOn(ptree, "exec").mockRejectedValue(new Error("unexpected Git query"));
	return () => {
		expect(directoryProbe).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(git).not.toHaveBeenCalled();
	};
}

describe("read-only execution binding resolution", () => {
	it("does not inspect the binding, filesystem or Git while disabled", async () => {
		const assertUninspected = forbidInspection();
		const header = {
			cwd: "/unavailable/home",
			get executionCwd(): unknown {
				throw new Error("unexpected binding inspection");
			},
		};
		expect(await resolveExecutionBinding(header, Settings.isolated())).toEqual({ kind: "disabled" });
		assertUninspected();
	});

	it("treats absent and cleared bindings as unassigned without filesystem or Git inspection", async () => {
		const assertUninspected = forbidInspection();
		expect(
			await resolveExecutionBinding(
				{ cwd: "/unavailable/home" },
				Settings.isolated({ "bwoah.executionWorkspace.enabled": true }),
			),
		).toEqual({ kind: "unassigned" });
		expect(await inspect("/unavailable/home", null)).toEqual({ kind: "unassigned" });
		assertUninspected();
	});

	it.each([42, " \t ", "relative/worktree", "/invalid\0path"])(
		"rejects malformed binding %p before inspection",
		async execution => {
			const assertUninspected = forbidInspection();
			await expectInvalid("/home", execution, "malformed-binding");
			assertUninspected();
		},
	);

	it("validates a linked worktree without changing H, the binding or runtime cwd", async () => {
		const { home, execution } = await linkedFixture();
		const header = Object.freeze({ cwd: home, executionCwd: `${execution}/../execution` });
		const launchCwd = process.cwd();
		expect(
			await resolveExecutionBinding(header, Settings.isolated({ "bwoah.executionWorkspace.enabled": true })),
		).toEqual({
			kind: "valid",
			executionCwd: header.executionCwd,
		});
		expect(header).toEqual({ cwd: home, executionCwd: `${execution}/../execution` });
		expect(process.cwd()).toBe(launchCwd);
	});

	it("recognizes H aliases and E aliases followed by parent traversal", async () => {
		const { home } = await linkedFixture();
		const homeAlias = root.join("home-alias");
		const executionAlias = root.join("execution-alias");
		await fs.symlink(home, homeAlias, "dir");
		await fs.symlink(await directory("execution/nested"), executionAlias, "dir");
		const executionCwd = `${executionAlias}/..`;
		expect(await inspect(homeAlias, executionCwd)).toEqual({ kind: "valid", executionCwd });
	});

	it("does not approve a lexical alternative to a missing symlink/../execution path", async () => {
		const home = await repository();
		const alias = path.join(home, "alias");
		await fs.symlink(await directory("target-parent/target"), alias, "dir");
		await directory("home/execution");
		await expectInvalid(home, `${alias}/../execution`, "missing-execution-directory");
	});

	it("rejects a worktree belonging to an unrelated repository", async () => {
		const home = await repository();
		await expectInvalid(home, await worktree(await repository("foreign")), "foreign-repository");
	});

	it.each(["home", "execution"])("rejects an ordinary non-Git %s after Git reports no repository", async role => {
		const home = role === "home" ? await directory("home") : await repository();
		await expectInvalid(home, await directory("execution"), "repository-unavailable");
	});

	it.each([
		{
			name: "missing E and H",
			home: "missing-home",
			execution: "missing-execution",
			reason: "missing-execution-directory",
		},
		{ name: "file E", home: ".", execution: "file", reason: "execution-not-directory" },
		{ name: "missing H", home: "missing-home", execution: ".", reason: "home-unavailable" },
	] as const)("rejects $name with the corresponding diagnostic", async ({ name, home, execution, reason }) => {
		if (name === "file E") await Bun.write(root.join(execution), "not a directory");
		await expectInvalid(root.join(home), root.join(execution), reason);
	});

	it("rejects E after a directory permission failure", async () => {
		vi.spyOn(dirs, "directoryIsEnterable").mockResolvedValue(false);
		await expectInvalid(root.path(), root.path(), "execution-unavailable");
	});

	it("rejects a standalone bare H without a checkout", async () => {
		const home = root.join("bare.git");
		await $`git init --bare ${home}`.quiet();
		await expectInvalid(home, await directory("execution"), "non-git-home");
	});

	it.each(["fresh", "dirty", "detached", "subdirectory"])("accepts a %s Git checkout", async state => {
		const home = await repository("home", state !== "fresh");
		let execution = state === "fresh" ? await directory("home/nested") : await worktree(home);
		if (state === "dirty") await Bun.write(path.join(execution, "untracked.txt"), "working changes");
		if (state === "detached") await $`git checkout --detach`.cwd(execution).quiet();
		if (state === "subdirectory") execution = await directory("execution/nested");
		expect(await inspect(home, execution)).toEqual({ kind: "valid", executionCwd: execution });
	});

	it.each(["home", "execution"])("rejects malformed HEAD in %s", async role => {
		const { home, execution } = await linkedFixture();
		await Bun.write(vcs.gitInfo(role === "home" ? home : execution)!.headPath, "malformed HEAD\n");
		await expectInvalid(home, execution, "repository-unavailable");
	});

	it.each(["home", "execution"])("rejects core.bare=true in %s", async role => {
		const { home, execution } = await linkedFixture();
		await $`git config extensions.worktreeConfig true`.cwd(home).quiet();
		await $`git config --worktree core.bare true`.cwd(role === "home" ? home : execution).quiet();
		await expectInvalid(home, execution, role === "home" ? "non-git-home" : "foreign-repository");
	});

	it.each(["home", "execution"])("rejects a malformed gitfile in %s", async role => {
		const home = role === "home" ? await directory("home") : await repository();
		const execution = await directory("execution");
		await Bun.write(path.join(role === "home" ? home : execution, ".git"), "gitdir: nonexistent-metadata");
		await expectInvalid(home, execution, "repository-unavailable");
	});

	it.each(["directory", "missing"])("rejects linked commondir metadata that is %s", async state => {
		const { home, execution, commondir } = await linkedFixture();
		await fs.unlink(commondir);
		if (state === "directory") await fs.mkdir(commondir);
		await expectInvalid(home, execution, "repository-unavailable");
	});

	it("preserves whitespace in the Git common directory path", async () => {
		const home = root.join("home");
		await $`git init --initial-branch=main --separate-git-dir ${root.join("metadata ")} ${home}`.quiet();
		const execution = await directory("home/execution");
		expect(await inspect(home, execution)).toEqual({ kind: "valid", executionCwd: execution });
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["home", "execution"])(
		"rejects an unreadable Git HEAD in %s",
		async role => {
			const { home, execution } = await linkedFixture();
			const head = vcs.gitInfo(role === "home" ? home : execution)!.headPath;
			await fs.chmod(head, 0o000);
			try {
				await expectInvalid(home, execution, "repository-unavailable");
			} finally {
				await fs.chmod(head, 0o644);
			}
		},
	);

	it("ignores ambient Git location overrides when comparing repositories", async () => {
		const home = await repository();
		const execution = await repository("foreign");
		const filter = environment.filterProcessEnv;
		const filterSpy = vi.spyOn(environment, "filterProcessEnv").mockImplementation(env => ({
			...filter(env),
			GIT_DIR: path.join(home, ".git"),
			GIT_COMMON_DIR: path.join(home, ".git"),
			GIT_WORK_TREE: home,
		}));
		await expectInvalid(home, execution, "foreign-repository");
		expect(filterSpy).toHaveBeenCalled();
	});

	it.each([
		"spawn failure",
		"timeout",
		"nonzero exit",
		"aborted",
		"zero exit with timeout error",
		"unexpected eligibility output",
		"empty common-dir output",
	])("rejects E after %s without waiting for a real timeout", async failure => {
		const query = vi.spyOn(ptree, "exec").mockImplementation(async cmd => {
			if (failure === "spawn failure" || failure === "timeout") throw new Error(failure);
			const ok = failure !== "nonzero exit" && failure !== "aborted";
			const stdout =
				failure === "unexpected eligibility output"
					? "unexpected\n"
					: cmd.includes("--is-inside-work-tree")
						? "true\n"
						: failure === "zero exit with timeout error"
							? `${root.path()}\n`
							: "\n";
			return {
				ok,
				stdout,
				stderr: "",
				exitCode: failure === "aborted" ? null : ok ? 0 : 128,
				exitError: failure === "zero exit with timeout error" ? new ptree.TimeoutError(5000, "") : undefined,
			};
		});
		await expectInvalid(root.path(), root.path(), "repository-unavailable");
		if (failure === "timeout") expect(query.mock.calls[0]?.[1]).toMatchObject({ timeout: 5000 });
	});

	it.each(["gitfile", "commondir"])("rejects foreign metadata reached through symlink/.. in %s", async pointer => {
		const { home, execution, commondir } = await linkedFixture();
		await repository("foreign");
		const alias = path.join(home, "alias");
		await fs.symlink(await directory("foreign/nested"), alias, "dir");
		const target = `${alias}/../.git\n`;
		if (pointer === "gitfile") await Bun.write(path.join(execution, ".git"), `gitdir: ${target}`);
		else await Bun.write(commondir, target);
		await expectInvalid(home, execution, "foreign-repository");
	});

	it.each([
		{ name: "Git metadata root as E", home: ".", execution: ".git" },
		{ name: "Git metadata descendant as E", home: ".", execution: ".git/objects" },
		{ name: "Git metadata root as H", home: ".git", execution: "." },
		{ name: "nested bare repository as E", home: ".", execution: "nested-bare.git" },
		{ name: "nested bare descendant as E", home: ".", execution: "nested-bare.git/objects" },
		{ name: "nested bare repository as H", home: "nested-bare.git", execution: "." },
	])("rejects $name instead of approving the surrounding checkout", async ({ home, execution }) => {
		const checkout = await repository();
		await $`git init --quiet --bare ${path.join(checkout, "nested-bare.git")}`.quiet();
		expect(await inspect(path.join(checkout, home), path.join(checkout, execution))).toMatchObject({
			kind: "invalid",
		});
	});
});
