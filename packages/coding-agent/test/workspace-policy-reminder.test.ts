/**
 * Workspace-policy classification and reminder rendering.
 *
 * `resolveWorkspacePolicyState` classifies the live execution directory via
 * real filesystem/native-VCS discovery: primary checkout, linked execution
 * worktree, trusted native isolated-task sandbox, or unverified. Rendering
 * must expose distinct permission semantics per kind without pinning prose.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	renderWorkspacePolicyReminder,
	resolveWorkspacePolicyState,
} from "@oh-my-pi/pi-coding-agent/session/workspace-policy";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("workspace policy resolver", () => {
	let root: string;
	afterEach(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	/** Only `git init` lacks a native facade API; config and the seed commit go through the VCS natives. */
	async function gitCli(cwd: string, ...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
		return stdout.trim();
	}

	async function initRepoAt(dir: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true });
		await gitCli(dir, "init", "-q", "-b", "main");
		const repo = vcs.git(dir);
		if (!repo) throw new Error(`git repository not discovered at ${dir}`);
		await repo.configSet("user.email", "test@example.com");
		await repo.configSet("user.name", "test");
		await Bun.write(path.join(dir, "README.md"), "seed\n");
		await repo.stageFiles(["README.md"]);
		await repo.commitCreate("init", {});
	}

	async function makeLinkedWorktree(homeDir: string, worktreePath: string, branch: string): Promise<void> {
		const repo = vcs.git(homeDir);
		if (!repo) throw new Error(`git repository not discovered at ${homeDir}`);
		await repo.createBranch(branch, "HEAD", false);
		await repo.worktreeAdd(worktreePath, branch, { detach: false, clone: false });
	}

	async function uniqueDir(prefix: string): Promise<string> {
		// Canonicalize once: on macOS mkdtemp under /var resolves to /private/var,
		// and expected paths must match the resolver's realpath'd output.
		root ??= await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-policy-")));
		const dir = path.join(root, prefix);
		await fs.mkdir(dir, { recursive: true });
		return dir;
	}

	it("classifies the primary root and a subdirectory as primary on a non-main branch", async () => {
		const primary = await uniqueDir("primary");
		await initRepoAt(primary);
		const repo = vcs.git(primary);
		if (!repo) throw new Error("primary repo not discovered");
		await repo.checkoutNewBranch("feature/not-main");

		expect(await resolveWorkspacePolicyState(primary)).toEqual({ kind: "primary", root: primary });

		const subdir = path.join(primary, "src", "deep");
		await fs.mkdir(subdir, { recursive: true });
		expect(await resolveWorkspacePolicyState(subdir)).toEqual({ kind: "primary", root: primary });
	});

	it("classifies a linked worktree, its symlink alias, and a subdirectory as worktree with the shared primary root", async () => {
		const primary = await uniqueDir("wt-primary");
		await initRepoAt(primary);
		const worktree = path.join(root, "wt-checkout");
		await makeLinkedWorktree(primary, worktree, "wt-branch");
		const expected = { kind: "worktree", root: worktree, primaryRoot: primary } as const;

		expect(await resolveWorkspacePolicyState(worktree)).toEqual(expected);

		const alias = path.join(root, "wt-alias");
		await fs.symlink(worktree, alias);
		expect(await resolveWorkspacePolicyState(alias)).toEqual(expected);

		const subdir = path.join(worktree, "packages");
		await fs.mkdir(subdir, { recursive: true });
		expect(await resolveWorkspacePolicyState(subdir)).toEqual(expected);
	});

	it("keeps the worktree classification under a detached HEAD in the linked checkout", async () => {
		const primary = await uniqueDir("detached-primary");
		await initRepoAt(primary);
		const worktree = path.join(root, "wt-detached");
		await makeLinkedWorktree(primary, worktree, "detached-branch");

		const wtRepo = vcs.git(worktree);
		if (!wtRepo) throw new Error("worktree repo not discovered");
		const sha = await wtRepo.headSha();
		if (!sha) throw new Error("worktree HEAD not resolved");
		await wtRepo.checkout(sha);

		expect(await resolveWorkspacePolicyState(worktree)).toEqual({
			kind: "worktree",
			root: worktree,
			primaryRoot: primary,
		});
	});

	it("trusts the isolated-task root exactly: matches inside, degrades to primary outside", async () => {
		const isolated = await uniqueDir("isolated-repo");
		await initRepoAt(isolated);

		expect(await resolveWorkspacePolicyState(isolated, isolated)).toEqual({ kind: "isolated", root: isolated });
		const primary = await uniqueDir("isolated-parent");
		expect(await resolveWorkspacePolicyState(isolated, isolated, primary)).toEqual({
			kind: "isolated",
			root: isolated,
			primaryRoot: primary,
		});

		// Same independent repository without the trusted context is an ordinary primary checkout.
		expect(await resolveWorkspacePolicyState(isolated)).toEqual({ kind: "primary", root: isolated });

		// A different repository must not inherit the exemption from a stale trusted root.
		const other = await uniqueDir("other-repo");
		await initRepoAt(other);
		expect(await resolveWorkspacePolicyState(other, isolated)).toEqual({ kind: "primary", root: other });
	});

	it("classifies a subdirectory of the isolated root as isolated", async () => {
		const isolated = await uniqueDir("isolated-sub");
		await initRepoAt(isolated);
		const subdir = path.join(isolated, "nested");
		await fs.mkdir(subdir, { recursive: true });
		expect(await resolveWorkspacePolicyState(subdir, isolated)).toEqual({ kind: "isolated", root: isolated });
	});

	it("yields unverified for a plain directory and a missing directory", async () => {
		const plain = await uniqueDir("plain");
		expect(await resolveWorkspacePolicyState(plain)).toEqual({ kind: "unverified" });
		expect(await resolveWorkspacePolicyState(path.join(root, "does-not-exist"))).toEqual({ kind: "unverified" });
	});
});

describe("workspace policy reminder rendering", () => {
	it("renders primary checkout as read-only pending a user-selected implementation checkout", () => {
		const text = renderWorkspacePolicyReminder("/repo/primary", { kind: "primary", root: "/repo/primary" });
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("Current working directory: /repo/primary");
		expect(text).toContain("operating in the repository's primary checkout");
		expect(text).toContain("Default to read-only investigation");
		expect(text).toContain("request an implementation checkout from the user");
		expect(text).not.toContain("MUST occur within this worktree");
	});

	it("renders worktree as work-scoped with a read-only primary root", () => {
		const text = renderWorkspacePolicyReminder("/repo/wt", {
			kind: "worktree",
			root: "/repo/wt",
			primaryRoot: "/repo/primary",
		});
		expect(text).toContain("Current working directory: /repo/wt");
		expect(text).toContain("Primary checkout root: /repo/primary");
		expect(text).toContain("operating in a worktree");
		expect(text).toContain("All your work MUST occur within this worktree");
		expect(text).toContain("read-only material");
		expect(text).not.toContain("primary checkout. Default to read-only");
	});

	it("renders isolated workspaces as strictly confined to the execution directory", () => {
		const text = renderWorkspacePolicyReminder("/iso", { kind: "isolated", root: "/iso" });
		expect(text).toContain("Current working directory: /iso");
		expect(text).toContain("All your work MUST occur within the current working directory");
		expect(text).toContain("read-only reference material");
		expect(text).not.toContain("Primary checkout root");
	});

	it("renders unverified with only the execution directory and no policy", () => {
		const text = renderWorkspacePolicyReminder("/nowhere", { kind: "unverified" });
		expect(text).toContain("Current working directory: /nowhere");
		expect(text).not.toContain("read-only investigation");
		expect(text).not.toContain("MUST occur");
		expect(text).not.toContain("Primary checkout root");
	});

	it("points at the system prompt's related-directories list only when related roots exist", () => {
		const worktree = { kind: "worktree", root: "/repo/wt", primaryRoot: "/repo/primary" } as const;
		const withRelated = renderWorkspacePolicyReminder("/repo/wt", worktree, true);
		expect(withRelated).toContain("Related read-only directories are listed in the system prompt");
		expect(withRelated).toContain("NEVER modify anything under them");
		const explicitFalse = renderWorkspacePolicyReminder("/repo/wt", worktree, false);
		expect(explicitFalse).not.toContain("Related read-only");
		const omitted = renderWorkspacePolicyReminder("/repo/wt", worktree);
		expect(omitted).not.toContain("Related read-only");
	});
});
