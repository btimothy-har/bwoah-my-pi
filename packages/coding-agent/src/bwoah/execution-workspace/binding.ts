import * as fs from "node:fs/promises";
import * as path from "node:path";
import { filterProcessEnv, isEnoent, ptree, stripGitRepoLocationEnv } from "@oh-my-pi/pi-utils";
import { directoryIsEnterable } from "@oh-my-pi/pi-utils/dirs";
import type { Settings } from "../../config/settings";
import { NON_INTERACTIVE_ENV } from "../../exec/non-interactive-env";
import { cfgExecutionWorkspaceEnabled } from "./settings";

export interface ExecutionBindingHeader {
	cwd: string;
	executionCwd?: unknown;
}

export type ExecutionBindingInvalidReason =
	| "malformed-binding"
	| "missing-execution-directory"
	| "execution-not-directory"
	| "foreign-repository"
	| "non-git-home"
	| "home-unavailable"
	| "execution-unavailable"
	| "repository-unavailable";

export type ExecutionBindingResolution =
	| { kind: "disabled" }
	| { kind: "unassigned" }
	| { kind: "valid"; executionCwd: string }
	| { kind: "invalid"; reason: ExecutionBindingInvalidReason };

interface FileIdentity {
	dev: bigint;
	ino: bigint;
}

async function queryGit(cwd: string, args: string[]): Promise<string> {
	const env = { ...filterProcessEnv(Bun.env), ...NON_INTERACTIVE_ENV };
	stripGitRepoLocationEnv(env);
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === "GIT_CEILING_DIRECTORIES") delete env[key];
	}
	const result = await ptree.exec(["git", "--no-optional-locks", "-C", cwd, "rev-parse", ...args], {
		env,
		timeout: 5_000,
		allowNonZero: true,
		allowAbort: true,
	});
	if (!result.ok || result.exitError) throw new Error("Git repository inspection failed", { cause: result.exitError });
	return result.stdout;
}

async function resolveCommonDirectoryIdentity(cwd: string): Promise<FileIdentity | null> {
	const inside = (await queryGit(cwd, ["--is-inside-work-tree"])).trim();
	if (inside === "false") return null;
	if (inside !== "true") throw new Error("Git working-tree membership could not be verified");
	const output = await queryGit(cwd, ["--path-format=absolute", "--git-common-dir"]);
	if (!output.endsWith("\n")) throw new Error("Git repository identity could not be verified");
	// Remove the output terminator without trimming whitespace from the directory name.
	let commonDir = output.slice(0, -1);
	if (process.platform === "win32" && commonDir.endsWith("\r")) commonDir = commonDir.slice(0, -1);
	if (!path.isAbsolute(commonDir)) throw new Error("Git common directory must be absolute");
	const directory = await fs.stat(commonDir, { bigint: true });
	if (!directory.isDirectory() || directory.ino === 0n) {
		throw new Error("Git repository identity could not be verified");
	}
	return directory;
}

/** Inspect an optional assignment without changing the session, runtime directory or saved header. */
export async function resolveExecutionBinding(
	header: ExecutionBindingHeader,
	settings: Settings,
): Promise<ExecutionBindingResolution> {
	if (!cfgExecutionWorkspaceEnabled.get(settings)) return { kind: "disabled" };
	const binding = header.executionCwd;
	if (binding === undefined || binding === null) return { kind: "unassigned" };
	if (
		typeof binding !== "string" ||
		binding.trim().length === 0 ||
		binding.includes("\0") ||
		!path.isAbsolute(binding)
	) {
		return { kind: "invalid", reason: "malformed-binding" };
	}

	// Preserve filesystem traversal: collapsing ".." before following a symlink changes its target.
	const executionCwd = binding;
	if (!(await directoryIsEnterable(executionCwd))) {
		try {
			const directory = await fs.stat(executionCwd);
			return {
				kind: "invalid",
				reason: directory.isDirectory() ? "execution-unavailable" : "execution-not-directory",
			};
		} catch (error) {
			return { kind: "invalid", reason: isEnoent(error) ? "missing-execution-directory" : "execution-unavailable" };
		}
	}

	if (!path.isAbsolute(header.cwd) || !(await directoryIsEnterable(header.cwd))) {
		return { kind: "invalid", reason: "home-unavailable" };
	}

	try {
		const homeCommonDirectory = await resolveCommonDirectoryIdentity(header.cwd);
		if (homeCommonDirectory === null) return { kind: "invalid", reason: "non-git-home" };
		const executionCommonDirectory = await resolveCommonDirectoryIdentity(executionCwd);
		if (
			executionCommonDirectory === null ||
			executionCommonDirectory.dev !== homeCommonDirectory.dev ||
			executionCommonDirectory.ino !== homeCommonDirectory.ino
		) {
			return { kind: "invalid", reason: "foreign-repository" };
		}
		return { kind: "valid", executionCwd };
	} catch {
		return { kind: "invalid", reason: "repository-unavailable" };
	}
}
