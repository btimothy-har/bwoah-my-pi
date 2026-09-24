/**
 * Contract tests for `workspace.related` resolution: canonical checkout
 * matching (primary root vs linked worktree primary), directory filtering,
 * shared context loading with @-import expansion, and related-root context
 * listing ownership.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RelatedWorkspaceEntry } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
// Registers all discovery providers with the capability registry;
// listRelatedContextFiles resolves context files through the "context-files" capability.
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	effectiveWorkspaceDirectories,
	listRelatedContextFiles,
	loadSharedContextFiles,
	normalizeRelatedWorkspaceMap,
	resolveRelatedWorkspace,
} from "@oh-my-pi/pi-coding-agent/session/related-workspace";
import { normalizePathForComparison, removeSyncWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-related-workspace-"));
});

afterEach(() => {
	removeSyncWithRetries(tempDir);
});

function mkdirp(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// Paths returned by the module are realpath-normalized; compare by canonical
// form so the tests do not depend on a platform's temp-dir symlink spelling.
function expectSamePath(actual: string | null, expected: string): void {
	expect(actual).not.toBeNull();
	if (actual === null) return;
	expect(normalizePathForComparison(actual)).toBe(normalizePathForComparison(expected));
}

const EMPTY = { key: null, directories: [], contextFiles: [] };
test("normalizes malformed related-workspace map entries without changing surviving path order", () => {
	const raw = {
		first: { directories: ["../a", 12, "../b"], contextFiles: ["ctx.md", null], note: "untouched" },
		invalid: "not an entry",
		last: { contextFiles: "not a list", directories: ["~/c"] },
	};
	expect(normalizeRelatedWorkspaceMap(raw)).toEqual({
		first: { directories: ["../a", "../b"], contextFiles: ["ctx.md"] },
		last: { directories: ["~/c"], contextFiles: [] },
	});
	expect(normalizeRelatedWorkspaceMap(null)).toEqual({});
});

describe("resolveRelatedWorkspace", () => {
	test("matches a primary checkout by ~-prefixed key and resolves entries against the canonical root", async () => {
		const fakeHome = mkdirp(path.join(tempDir, "home"));
		const repo = mkdirp(path.join(fakeHome, "repo"));
		const cwd = mkdirp(path.join(repo, "sub"));
		const sibling = mkdirp(path.join(fakeHome, "sibling"));
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
		try {
			const related: Record<string, RelatedWorkspaceEntry> = {
				"~/repo": {
					directories: ["../sibling", sibling, repo, "./missing-dir", "sub", 42 as unknown as string],
					contextFiles: ["shared/ctx.md"],
				},
			};

			const resolved = await resolveRelatedWorkspace({ state: { kind: "primary", root: repo }, cwd, related });

			expectSamePath(resolved.key, repo);
			// Relative entries use the canonical root, not cwd; the duplicate,
			// missing, malformed, cwd, and ancestor entries are all excluded.
			expect(resolved.directories).toHaveLength(1);
			expectSamePath(resolved.directories[0], sibling);
			// Context files resolve against the canonical root without an existence check.
			expect(resolved.contextFiles).toEqual([path.join(repo, "shared", "ctx.md")]);
		} finally {
			homedirSpy.mockRestore();
		}
	});

	test("matches a linked worktree by its primary root", async () => {
		const repo = mkdirp(path.join(tempDir, "repo"));
		const worktree = mkdirp(path.join(tempDir, "repo-wt"));
		const sibling = mkdirp(path.join(tempDir, "sibling"));
		const related: Record<string, RelatedWorkspaceEntry> = {
			[repo]: { directories: ["../sibling", worktree] },
		};

		const resolved = await resolveRelatedWorkspace({
			state: { kind: "worktree", root: worktree, primaryRoot: repo },
			cwd: worktree,
			related,
		});

		expectSamePath(resolved.key, repo);
		// Keyed by the worktree's canonical checkout: "../sibling" resolves against
		// the primary root even though cwd is the worktree, and the worktree itself
		// is excluded as cwd.
		expect(resolved.directories).toHaveLength(1);
		expectSamePath(resolved.directories[0], sibling);
	});

	test("returns the empty workspace for isolated, unverified, unmatched, and malformed inputs", async () => {
		const repo = mkdirp(path.join(tempDir, "repo"));
		const sibling = mkdirp(path.join(tempDir, "sibling"));
		const related: Record<string, RelatedWorkspaceEntry> = { [repo]: { directories: [sibling] } };

		// An isolated sandbox root equal to a map key must never match.
		await expect(
			resolveRelatedWorkspace({ state: { kind: "isolated", root: repo }, cwd: repo, related }),
		).resolves.toEqual(EMPTY);
		await expect(resolveRelatedWorkspace({ state: { kind: "unverified" }, cwd: repo, related })).resolves.toEqual(
			EMPTY,
		);
		// A primary checkout with no matching key.
		await expect(
			resolveRelatedWorkspace({ state: { kind: "primary", root: sibling }, cwd: sibling, related }),
		).resolves.toEqual(EMPTY);
		// A matching key whose entry is not a plain object.
		const malformed = { [repo]: "nope" } as unknown as Record<string, RelatedWorkspaceEntry>;
		await expect(
			resolveRelatedWorkspace({ state: { kind: "primary", root: repo }, cwd: repo, related: malformed }),
		).resolves.toEqual(EMPTY);
	});
});

describe("effectiveWorkspaceDirectories", () => {
	test("unions session and related directories with first-wins dedup and cwd exclusion", () => {
		const cwd = mkdirp(path.join(tempDir, "cwd"));
		const a = mkdirp(path.join(tempDir, "a"));
		const b = mkdirp(path.join(tempDir, "b"));
		const c = mkdirp(path.join(tempDir, "c"));

		// The "/."-suffixed spellings are distinct strings that canonicalize to b
		// and cwd: raw-string dedup would keep them, canonical comparison drops them.
		const result = effectiveWorkspaceDirectories(cwd, [a, b], [`${b}${path.sep}.`, `${cwd}${path.sep}.`, c]);
		expect(result).toEqual([a, b, c]);
	});

	test("excludes ancestor roots of a nested execution directory", () => {
		const primary = mkdirp(path.join(tempDir, "primary"));
		const worktree = mkdirp(path.join(primary, "worktree"));
		const cwd = mkdirp(path.join(worktree, "pkg"));
		const child = mkdirp(path.join(cwd, "vendor"));
		const sibling = mkdirp(path.join(tempDir, "sibling"));

		const result = effectiveWorkspaceDirectories(cwd, [primary, sibling], [worktree, child]);
		expect(result).toEqual([sibling, child]);
	});
});

describe("loadSharedContextFiles", () => {
	test("loads files in order with @-imports expanded, skipping missing and empty files", async () => {
		const dir = mkdirp(path.join(tempDir, "ctx"));
		fs.writeFileSync(path.join(dir, "extra.md"), "EXPANDED-CONTEXT");
		const main = path.join(dir, "main.md");
		fs.writeFileSync(main, "Intro line.\n@./extra.md\nOutro line.\n");
		const second = path.join(dir, "second.md");
		fs.writeFileSync(second, "SECOND-CONTEXT");
		fs.writeFileSync(path.join(dir, "empty.md"), "  \n\t\n");

		const files = await loadSharedContextFiles([
			main,
			path.join(dir, "missing.md"),
			second,
			path.join(dir, "empty.md"),
		]);

		expect(files.map(file => file.path)).toEqual([main, second]);
		expect(files[0].content).toContain("Intro line.");
		expect(files[0].content).toContain("EXPANDED-CONTEXT");
		expect(files[0].content).toContain("Outro line.");
		expect(files[0].content).not.toContain("@./extra.md");
		expect(files[1].content).toContain("SECOND-CONTEXT");
	});
});

describe("listRelatedContextFiles", () => {
	test("lists project-level context files owned by the root and nothing outside it", async () => {
		const root = mkdirp(path.join(tempDir, "related"));
		fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT-RULE");
		// Project-level for the walk-up from root, but not owned by it.
		fs.writeFileSync(path.join(tempDir, "AGENTS.md"), "PARENT-RULE");

		const [entry] = await listRelatedContextFiles([root]);

		expectSamePath(entry.path, root);
		const listed = entry.contextFiles.map(normalizePathForComparison);
		expect(listed).toContain(normalizePathForComparison(path.join(root, "AGENTS.md")));
		expect(listed).not.toContain(normalizePathForComparison(path.join(tempDir, "AGENTS.md")));
		// Ownership is path containment: no listed path — project-level ancestor or
		// user-level file — may lie outside the root.
		for (const listedPath of entry.contextFiles) {
			const relative = path.relative(root, listedPath);
			expect(relative).not.toBe("");
			expect(relative.startsWith("..")).toBe(false);
			expect(path.isAbsolute(relative)).toBe(false);
		}
	});

	test("lists an owned context path when its file is symlinked outside the root", async () => {
		const root = mkdirp(path.join(tempDir, "linked"));
		const target = path.join(tempDir, "shared-rules.md");
		fs.writeFileSync(target, "SHARED-RULE");
		const instructionPath = path.join(root, "AGENTS.md");
		fs.symlinkSync(target, instructionPath);

		const [entry] = await listRelatedContextFiles([root]);
		expect(entry.contextFiles).toContain(instructionPath);
	});
});
