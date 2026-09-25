import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import type { CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { PrDiffPayload, ViewLookupResult } from "@oh-my-pi/pi-coding-agent/tools/gh";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import type { VcsGitRepo, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const SAMPLE_JJ_DIFF = `diff --git a/src/workspace.ts b/src/workspace.ts
--- a/src/workspace.ts
+++ b/src/workspace.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

const SAMPLE_PR_DIFF = `diff --git a/src/pr.ts b/src/pr.ts
--- a/src/pr.ts
+++ b/src/pr.ts
@@ -1 +1 @@
-export const pr = false;
+export const pr = true;
`;

function makeManyFileDiff(fileCount: number): string {
	return Array.from(
		{ length: fileCount },
		(_, idx) => `diff --git a/src/pr-${idx}.ts b/src/pr-${idx}.ts
--- a/src/pr-${idx}.ts
+++ b/src/pr-${idx}.ts
@@ -1 +1 @@
-export const pr${idx} = false;
+export const pr${idx} = true;
`,
	).join("\n");
}

interface SelectCall {
	title: string;
	options: string[];
}

interface NotifyCall {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

function makePrDiffLookup(unified: string): ViewLookupResult<PrDiffPayload> {
	return {
		rendered: unified,
		sourceUrl: undefined,
		payload: { unified, files: [] },
		status: "fresh",
		fetchedAt: Date.now(),
	};
}

function makeUserEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-05T00:00:00.000Z",
		message: {
			role: "user",
			content,
			timestamp: Date.now(),
		},
	};
}

interface EditorCall {
	title: string;
	prefill: string | undefined;
	editorOptions: { promptStyle?: boolean } | undefined;
}

describe("ReviewCommand", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-command-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await removeWithRetries(tmpDir);
	});

	function createTempDir(): string {
		return tmpDir;
	}

	function createContext(options?: {
		hasUI?: boolean;
		selectedMode?: string;
		selectResults?: string[];
		editorValue?: string | undefined;
		sessionEntries?: SessionEntry[];
		branchEntries?: SessionEntry[];
		sessionId?: string;
		sessionCwd?: string;
		sessionState?: { sessionId: string; cwd: string };
		onEditorCall?: (call: EditorCall) => void;
		onSelectCall?: (call: SelectCall) => void;
		onNotify?: (call: NotifyCall) => void;
	}): HookCommandContext {
		const selectResults = [...(options?.selectResults ?? [])];
		const session = options?.sessionState ?? {
			sessionId: options?.sessionId ?? "review-session",
			cwd: options?.sessionCwd ?? tmpDir,
		};
		return {
			hasUI: options?.hasUI ?? true,
			sessionManager: {
				getSessionId: () => session.sessionId,
				getCwd: () => session.cwd,
				getEntries: () => options?.sessionEntries ?? [],
				getBranch: () => options?.branchEntries ?? options?.sessionEntries ?? [],
			},
			ui: {
				select: (title: string, selectOptions: string[]) => {
					options?.onSelectCall?.({ title, options: selectOptions });
					return Promise.resolve(
						selectResults.shift() ?? options?.selectedMode ?? "4. Custom review instructions",
					);
				},
				editor: (
					title: string,
					prefill?: string,
					_options?: { signal?: AbortSignal },
					editorOptions?: { promptStyle?: boolean },
				) => {
					options?.onEditorCall?.({ title, prefill, editorOptions });
					return Promise.resolve(options?.editorValue);
				},
				notify: (message: string, type?: "info" | "warning" | "error") => {
					options?.onNotify?.({ message, type });
				},
			},
		} as unknown as HookCommandContext;
	}

	it("uses prompt-style input for custom review instructions", async () => {
		const dir = await createTempDir();
		let editorCall: EditorCall | undefined;

		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Check authentication boundaries",
			onEditorCall: call => {
				editorCall = call;
			},
		});

		const result = await command.execute([], ctx);

		expect(editorCall).toEqual({
			title: "Enter custom review instructions",
			prefill: "Review the following:\n\n",
			editorOptions: { promptStyle: true },
		});
		expect(result).toContain("Check authentication boundaries");
	});

	it("renders custom review instructions through the reviewer task prompt when no diff is available", async () => {
		const dir = await createTempDir();
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Check authentication boundaries",
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain("Check authentication boundaries");
		expect(promptText).toContain("skill://code-review");
	});

	it("does not submit empty custom review instructions", async () => {
		const values = [undefined, "", "   \n\t  "];

		for (const editorValue of values) {
			const dir = await createTempDir();
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({ editorValue });

			const result = await command.execute([], ctx);

			expect(result).toBeUndefined();
		}
	});

	it("uses JJ diff for uncommitted review prompts", async () => {
		const dir = await createTempDir();
		const jjDiffSpy = vi.fn(async () => SAMPLE_JJ_DIFF);
		const jjRepoSpy = spyOn(vcs, "require").mockReturnValue({
			kind: () => "jj",
			uncommittedDiff: jjDiffSpy,
		} as unknown as VcsRepo);
		const gitRepoSpy = spyOn(vcs, "requireGit");
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				selectedMode: "2. Review uncommitted changes",
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain("src/workspace.ts");
			expect(promptText).toContain("+1/-1");
			expect(promptText).toContain("MAY read full file context as needed via `read`");
			expect(jjDiffSpy).toHaveBeenCalledWith([]);
			expect(gitRepoSpy).not.toHaveBeenCalled();
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
			gitRepoSpy.mockRestore();
		}
	});

	it("includes JJ diff context for custom review prompts", async () => {
		const dir = await createTempDir();
		const jjDiffSpy = vi.fn(async () => SAMPLE_JJ_DIFF);
		const jjRepoSpy = spyOn(vcs, "require").mockReturnValue({
			kind: () => "jj",
			uncommittedDiff: jjDiffSpy,
		} as unknown as VcsRepo);
		const gitRepoSpy = spyOn(vcs, "requireGit");
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				editorValue: "Check workspace state transitions",
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain("Check workspace state transitions");
			expect(promptText).toContain("src/workspace.ts");
			expect(gitRepoSpy).not.toHaveBeenCalled();
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
			gitRepoSpy.mockRestore();
		}
	});

	it("uses the live session cwd instead of the load-time cwd (issue #12501)", async () => {
		const staleDir = path.join(tmpDir, "stale-checkout");
		const liveDir = path.join(tmpDir, "live-worktree");
		const requireSpy = spyOn(vcs, "require").mockReturnValue({
			kind: () => "git",
			uncommittedDiff: async () => "diff --git a/f.txt b/f.txt",
		} as unknown as VcsRepo);
		try {
			const command = new ReviewCommand({ cwd: staleDir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				selectedMode: "2. Review uncommitted changes",
				sessionCwd: liveDir,
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			expect(requireSpy).toHaveBeenCalledWith(liveDir);
			expect(requireSpy).not.toHaveBeenCalledWith(staleDir);
		} finally {
			requireSpy.mockRestore();
		}
	});

	it("parses supported explicit PR URL formats", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({ hasUI: false });

		const cases = [
			"https://github.com/owner/repo/pull/123",
			"https://github.com/owner/repo/pull/123/",
			"https://github.com/owner/repo/pull/123?tab=files",
			"https://github.com/owner/repo/pull/123#discussion_r123",
			"https://github.com/owner/repo/pull/123/files",
			"https://github.com/owner/repo/pull/123/commits",
			"pr://owner/repo/123/diff/all",
			"pr://owner/repo/123/diff/1",
		];

		for (const url of cases) {
			const result = await command.execute([url], ctx);

			expect(result).toBeDefined();
			expect(result!).toContain("PR owner/repo#123");
			expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/repo", number: 123 });
		}
	});

	it("prevents local file reads for PR URL reviews", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({ hasUI: false });

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("MUST NOT read local workspace files for PR file context");
		expect(result!).toContain("`pr://owner/repo/123/diff/all`");
		expect(result!).toContain("per-file `pr://owner/repo/123/diff/<index>`");
		expect(result!).not.toContain("MAY read full file context as needed via `read`");
	});

	it("uses PR diff URLs for omitted large PR diff instructions", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(makeManyFileDiff(21)));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({ hasUI: false });

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("MUST read assigned PR file diffs from `pr://owner/repo/123/diff/all`");
		expect(result!).toContain("per-file `pr://owner/repo/123/diff/<index>`");
		expect(result!).toContain("NEVER use local `git diff`/`git show` for PR diff content");
		expect(result!).not.toContain("MUST run `git diff`/`git show` for assigned files");
	});

	it("rejects unsupported PR-like URL formats as normal instructions", async () => {
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: "/tmp" } as unknown as CustomCommandAPI);
		const ctx = createContext({ hasUI: false });

		const cases = [
			"https://github.com/owner/repo/issues/123",
			"https://github.com/owner/repo/commit/abc123",
			"https://example.com/owner/repo/pull/123",
			"pr://123",
			"https://github.com/owner/repo/pull/0",
			"https://github.com/owner/repo/pull/-1",
			"https://github.com/owner/repo/pull/not-a-number",
		];

		for (const url of cases) {
			const result = await command.execute([url], ctx);

			expect(result).toBeDefined();
			expect(result!).toContain(url);
		}
		expect(diffSpy).not.toHaveBeenCalled();
	});

	it("removes only the first valid PR URL from extra instructions", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({ hasUI: false });
		const secondUrl = "https://github.com/owner/repo/pull/456";

		const result = await command.execute(["focus", "https://github.com/owner/repo/pull/123", "on", secondUrl], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("focus on https://github.com/owner/repo/pull/456");
		expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/repo", number: 123 });
	});

	it("bypasses the interactive menu for explicit PR URLs", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		let selectCalled = false;
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			onSelectCall: () => {
				selectCalled = true;
			},
		});

		const result = await command.execute(["https://github.com/owner/repo/pull/123", "focus", "on", "CLI", "UX"], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("focus on CLI UX");
		expect(selectCalled).toBe(false);
		expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/repo", number: 123 });
	});

	it("notifies and stops when explicit PR diff fetching fails", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockRejectedValue(new Error("authentication required"));
		const notifications: NotifyCall[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			onNotify: call => {
				notifications.push(call);
			},
		});

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeUndefined();
		expect(notifications).toEqual([
			{
				message: "Failed to fetch PR diff for owner/repo#123: authentication required",
				type: "error",
			},
		]);
	});

	it("notifies and stops when explicit PR diff content is empty", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(" \n"));
		const notifications: NotifyCall[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			onNotify: call => {
				notifications.push(call);
			},
		});

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeUndefined();
		expect(notifications).toEqual([
			{
				message: "PR owner/repo#123 has no diff content available",
				type: "warning",
			},
		]);
	});

	it("reviews a detected PR from recent conversation context", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectedMode: "Review PR owner/example#77 from conversation",
			sessionEntries: [makeUserEntry("u1", "Please review https://github.com/owner/example/pull/77.")],
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("PR owner/example#77");
		expect(result!).toContain("src/pr.ts");
		expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/example", number: 77 });
	});

	it("does not detect PR URLs from entries outside the current branch", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [makeUserEntry("stale", "Stale https://github.com/owner/example/pull/77")],
			branchEntries: [],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions).not.toContain("Review PR owner/example#77 from conversation");
	});

	it("detects only PR URLs from the active branch path", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry("stale", "Stale https://github.com/owner/example/pull/77"),
				makeUserEntry("active", "Active https://github.com/owner/example/pull/78"),
			],
			branchEntries: [makeUserEntry("active", "Active https://github.com/owner/example/pull/78")],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions).toContain("Review PR owner/example#78 from conversation");
		expect(reviewModeOptions).not.toContain("Review PR owner/example#77 from conversation");
	});

	it("deduplicates detected PR menu entries", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry("u1", "Review https://github.com/owner/example/pull/77 and pr://owner/example/77/diff/1"),
			],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(
			reviewModeOptions.filter(option => option === "Review PR owner/example#77 from conversation"),
		).toHaveLength(1);
	});

	it("orders detected PR menu entries by most recent mention", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry("u1", "Older https://github.com/owner/example/pull/77"),
				makeUserEntry("u2", "Newer https://github.com/owner/example/pull/78"),
			],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions.slice(0, 2)).toEqual([
			"Review PR owner/example#78 from conversation",
			"Review PR owner/example#77 from conversation",
		]);
	});

	it("orders detected PR menu entries by rightmost mention within one message", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry(
					"u1",
					"Older https://github.com/owner/example/pull/77 newer https://github.com/owner/example/pull/78",
				),
			],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions.slice(0, 2)).toEqual([
			"Review PR owner/example#78 from conversation",
			"Review PR owner/example#77 from conversation",
		]);
	});

	it("preserves the existing menu shape when no recent PR is detected", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions).toEqual([
			"1. Review against a base branch (PR Style)",
			"2. Review uncommitted changes",
			"3. Review a specific commit",
			"4. Custom review instructions",
		]);
	});

	it("keeps base branch review mode working with resolved SHAs", async () => {
		const dir = await createTempDir();
		const diffSpy = vi.fn(async () => SAMPLE_PR_DIFF);
		const mergeBaseSpy = vi.fn(async () => "basesha");
		const repository = {
			info: () => ({ repoRoot: dir }),
			resolveRef: async (name: string) => (name === "main" ? "mainsha" : "featsha"),
			currentBranch: async () => "feature",
			mergeBase: mergeBaseSpy,
			diffText: diffSpy,
			listBranches: async () => ["main"],
		} as unknown as VcsGitRepo;
		spyOn(vcs, "git").mockReturnValue(repository);
		spyOn(vcs, "requireGit").mockReturnValue(repository);
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectResults: ["1. Review against a base branch (PR Style)", "main"],
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("Reviewing changes between `main` and `feature`");
		expect(result!).toContain("src/pr.ts");
		expect(mergeBaseSpy).toHaveBeenCalledWith("mainsha", "featsha");
		expect(diffSpy).toHaveBeenCalledWith({ base: "basesha", head: "featsha" });
		expect(result!).toContain(`Repository root: \`${dir}\``);
		expect(result!).toContain("Comparison base (merge base): basesha");
		expect(result!).toContain("Selected base branch: `main` (tip mainsha)");
		expect(result!).toContain("skill://code-review");
	});

	it("resolves base-branch review against a real repo without a range revspec", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-real-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();
			await $`git config user.name Test`.cwd(dir).quiet();
			// Hermetic fixtures: the host may set commit.gpgsign globally, and a
			// locked gpg agent would hang git commit.
			await $`git config commit.gpgsign false`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "one\n");
			await $`git add a.txt`.cwd(dir).quiet();
			await $`git commit -q -m init`.cwd(dir).quiet();

			// Same branch selected as base: must report no changes, not crash on
			// a `main...main` revspec that rev_parse_single cannot resolve.
			const sameBranch = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const notices: NotifyCall[] = [];
			const sameResult = await sameBranch.execute(
				[],
				createContext({
					sessionCwd: dir,
					selectResults: ["1. Review against a base branch (PR Style)", "main"],
					onNotify: call => notices.push(call),
				}),
			);
			expect(sameResult).toBeUndefined();
			expect(notices).toEqual([{ message: "No changes between main and main", type: "warning" }]);

			// Feature branch changes a.txt; main independently advances with a
			// base-only file. PR-style (merge-base) review must show only the
			// feature change, never main's base-only file. A two-tree
			// (`base head`) diff would surface base-only.txt as a reverse
			// deletion — the regression this asserts against.
			await $`git checkout -q -b feature`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "two\n");
			await $`git commit -q -am feature-change`.cwd(dir).quiet();
			await $`git checkout -q main`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "base-only.txt"), "base\n");
			await $`git add base-only.txt`.cwd(dir).quiet();
			await $`git commit -q -m base-advance`.cwd(dir).quiet();
			await $`git checkout -q feature`.cwd(dir).quiet();
			const feature = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const featureResult = await feature.execute(
				[],
				createContext({
					sessionCwd: dir,
					selectResults: ["1. Review against a base branch (PR Style)", "main"],
				}),
			);
			expect(featureResult).toContain("Reviewing changes between `main` and `feature`");
			expect(featureResult).toContain("a.txt");
			expect(featureResult).not.toContain("base-only.txt");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("rejects base-branch review when histories share no merge base", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-orphan-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();
			await $`git config user.name Test`.cwd(dir).quiet();
			// Hermetic fixtures: the host may set commit.gpgsign globally, and a
			// locked gpg agent would hang git commit.
			await $`git config commit.gpgsign false`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "one\n");
			await $`git add a.txt`.cwd(dir).quiet();
			await $`git commit -q -m init`.cwd(dir).quiet();

			// Orphan branch: no common ancestor with main, so PR-style review
			// must abort instead of comparing the two unrelated trees.
			await $`git checkout -q --orphan orphan`.cwd(dir).quiet();
			await $`git rm -q -rf .`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "b.txt"), "other\n");
			await $`git add b.txt`.cwd(dir).quiet();
			await $`git commit -q -m orphan`.cwd(dir).quiet();

			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const notices: NotifyCall[] = [];
			const result = await command.execute(
				[],
				createContext({
					sessionCwd: dir,
					selectResults: ["1. Review against a base branch (PR Style)", "main"],
					onNotify: call => notices.push(call),
				}),
			);
			expect(result).toBeUndefined();
			expect(notices).toEqual([{ message: "No common history between main and orphan", type: "error" }]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("keeps specific commit review mode working with the resolved SHA", async () => {
		const dir = await createTempDir();
		const resolvedSha = "abcdef890abcdef890abcdef890abcdef890abcdef89";
		const showSpy = vi.fn(async () => ({ data: Buffer.from(SAMPLE_PR_DIFF), truncated: false }));
		spyOn(vcs, "require").mockReturnValue({
			logOnelines: async () => ["abc1234 Fix review command"],
		} as unknown as VcsRepo);
		spyOn(vcs, "requireGit").mockReturnValue({
			info: () => ({ repoRoot: dir }),
			resolveRef: async (name: string) => (name === "abc1234" ? resolvedSha : null),
			showCommit: showSpy,
		} as unknown as VcsGitRepo);
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectResults: ["3. Review a specific commit", "abc1234 Fix review command"],
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain(`Reviewing commit \`${resolvedSha}\``);
		expect(result!).toContain("src/pr.ts");
		expect(showSpy).toHaveBeenCalledWith(resolvedSha);
		expect(result!).toContain(`Commit: ${resolvedSha}`);
	});

	it("rejects commit review when the selected ref cannot be resolved", async () => {
		const dir = await createTempDir();
		const showSpy = vi.fn(async () => ({ data: Buffer.from(SAMPLE_PR_DIFF), truncated: false }));
		spyOn(vcs, "require").mockReturnValue({
			logOnelines: async () => ["abc1234 Fix review command"],
		} as unknown as VcsRepo);
		spyOn(vcs, "requireGit").mockReturnValue({
			info: () => ({ repoRoot: dir }),
			resolveRef: async () => null,
			showCommit: showSpy,
		} as unknown as VcsGitRepo);
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const notifications: NotifyCall[] = [];
		const ctx = createContext({
			selectResults: ["3. Review a specific commit", "abc1234 Fix review command"],
			onNotify: call => notifications.push(call),
		});
		const result = await command.execute([], ctx);

		expect(result).toBeUndefined();
		expect(showSpy).not.toHaveBeenCalled();
		expect(notifications).toEqual([{ message: "Cannot resolve commit abc1234", type: "error" }]);
	});

	it("pins large merge-commit review to a first-parent show of the resolved SHA", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-merge-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();
			await $`git config user.name Test`.cwd(dir).quiet();
			// Hermetic fixture: the host may set commit.gpgsign globally, and a
			// locked gpg agent would hang git commit.
			await $`git config commit.gpgsign false`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "one\n");
			await $`git add a.txt`.cwd(dir).quiet();
			await $`git commit -q -m init`.cwd(dir).quiet();

			// Feature branch adds 25 files: the merge commit's first-parent
			// patch exceeds MAX_FILES_FOR_INLINE_DIFF, forcing the large-diff
			// path where the reviewer instruction names the exact show command.
			await $`git checkout -q -b feature`.cwd(dir).quiet();
			for (let idx = 0; idx < 25; idx++) {
				await fs.writeFile(path.join(dir, `feature-${idx}.ts`), `export const value${idx} = ${idx};\n`);
				await $`git add feature-${idx}.ts`.cwd(dir).quiet();
			}
			await $`git commit -q -m feature-files`.cwd(dir).quiet();
			await $`git checkout -q main`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "two\n");
			await $`git commit -q -am main-advance`.cwd(dir).quiet();
			await $`git merge -q --no-ff -m merge-commit feature`.cwd(dir).quiet();
			const mergeSha = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim();

			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				sessionCwd: dir,
				selectResults: ["3. Review a specific commit", `${mergeSha.slice(0, 7)} merge-commit`],
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain(`Reviewing commit \`${mergeSha}\``);
			// The reviewer instruction must match the first-parent patch the
			// inline path would have shown: a plain `git show` on a merge
			// commit returns an empty/combined patch and loses content.
			expect(promptText).toContain(`git show --first-parent ${mergeSha} -- <path>`);
			expect(promptText).toContain("Diff Previews");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("renders headless review requests through the reviewer task prompt", async () => {
		const command = new ReviewCommand({ cwd: "/tmp" } as unknown as CustomCommandAPI);
		const ctx = createContext({ hasUI: false });

		const result = await command.execute(["focus", "auth"], ctx);

		const promptText = result!;
		expect(promptText).toContain("focus auth");
		expect(promptText).toContain("skill://code-review");
	});

	it("pins branch review to the SHAs resolved at selection time", async () => {
		const dir = await createTempDir();
		const mainShaBefore = "b".repeat(40);
		const featureShaBefore = "c".repeat(40);
		// Diverged history: the merge base differs from the base branch tip.
		const mergeBaseSha = "m".repeat(40);
		const featureShaAfter = "e".repeat(40);
		const refs = new Map([
			["main", mainShaBefore],
			["feature", featureShaBefore],
		]);
		const mergeBaseSpy = vi.fn(async () => {
			// Branch tips move after the command resolved both SHAs but before
			// diffing: acquisition must still use the resolved pre-move SHAs.
			refs.set("main", "d".repeat(40));
			refs.set("feature", featureShaAfter);
			return mergeBaseSha;
		});
		const diffSpy = vi.fn(async () => SAMPLE_PR_DIFF);
		const repository = {
			info: () => ({ repoRoot: dir }),
			resolveRef: async (name: string) => refs.get(name) ?? null,
			currentBranch: async () => "feature",
			mergeBase: mergeBaseSpy,
			diffText: diffSpy,
			listBranches: async () => ["main", "feature"],
		} as unknown as VcsGitRepo;
		spyOn(vcs, "git").mockReturnValue(repository);
		spyOn(vcs, "requireGit").mockReturnValue(repository);
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const state = { sessionId: "review-session", cwd: dir };
		const ctx = createContext({
			selectResults: ["1. Review against a base branch (PR Style)", "main"],
			sessionState: state,
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(mergeBaseSpy).toHaveBeenCalledWith(mainShaBefore, featureShaBefore);
		expect(diffSpy).toHaveBeenCalledWith({ base: mergeBaseSha, head: featureShaBefore });
		expect(promptText).toContain(`Comparison base (merge base): ${mergeBaseSha}`);
		expect(promptText).toContain(`(tip ${mainShaBefore})`);
		expect(promptText).toContain(featureShaBefore);
		expect(promptText).not.toContain(featureShaAfter);
	});

	it("limits branch review to committed changes, excluding staged and unstaged edits", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-live-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();
			await $`git config user.name Test`.cwd(dir).quiet();
			// Hermetic fixtures: the host may set commit.gpgsign globally, and a
			// locked gpg agent would hang git commit.
			await $`git config commit.gpgsign false`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "one\n");
			await $`git add a.txt`.cwd(dir).quiet();
			await $`git commit -q -m init`.cwd(dir).quiet();
			await $`git checkout -q -b feature`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "committed.ts"), "export const value = 1;\n");
			await $`git add committed.ts`.cwd(dir).quiet();
			await $`git commit -q -m feature-change`.cwd(dir).quiet();

			// Live working-tree edits unrelated to the committed review scope.
			await fs.writeFile(path.join(dir, "staged.ts"), "export const staged = true;\n");
			await $`git add staged.ts`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "committed.ts"), "export const value = 2;\n");

			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const result = await command.execute(
				[],
				createContext({
					sessionCwd: dir,
					selectResults: ["1. Review against a base branch (PR Style)", "main"],
				}),
			);

			expect(result).toBeDefined();
			expect(result!).toContain("committed.ts");
			expect(result!).not.toContain("staged.ts");
			expect(result!).toContain("staged and unstaged changes are excluded");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("refuses to dispatch when the session changes during the scope picker", async () => {
		const dir = await createTempDir();
		const jjDiffSpy = vi.fn(async () => SAMPLE_JJ_DIFF);
		const jjRepoSpy = spyOn(vcs, "require").mockReturnValue({
			kind: () => "jj",
			uncommittedDiff: jjDiffSpy,
		} as unknown as VcsRepo);
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const state = { sessionId: "session-1", cwd: dir };
			const notifications: NotifyCall[] = [];
			const ctx = createContext({
				selectedMode: "2. Review uncommitted changes",
				sessionState: state,
				onSelectCall: () => {
					state.sessionId = "session-2";
				},
				onNotify: call => notifications.push(call),
			});

			const result = await command.execute([], ctx);

			expect(result).toBeUndefined();
			expect(jjDiffSpy).toHaveBeenCalledTimes(1);
			expect(notifications.some(call => call.type === "warning")).toBe(true);
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
		}
	});

	it("refuses to dispatch when the working directory changes during the scope picker", async () => {
		const dir = await createTempDir();
		const jjDiffSpy = vi.fn(async () => SAMPLE_JJ_DIFF);
		const jjRepoSpy = spyOn(vcs, "require").mockReturnValue({
			kind: () => "jj",
			uncommittedDiff: jjDiffSpy,
		} as unknown as VcsRepo);
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const state = { sessionId: "session-1", cwd: dir };
			const notifications: NotifyCall[] = [];
			const ctx = createContext({
				selectedMode: "2. Review uncommitted changes",
				sessionState: state,
				onSelectCall: () => {
					state.cwd = path.join(dir, "elsewhere");
				},
				onNotify: call => notifications.push(call),
			});

			const result = await command.execute([], ctx);

			expect(result).toBeUndefined();
			expect(jjDiffSpy).toHaveBeenCalledTimes(1);
			expect(notifications.some(call => call.type === "warning")).toBe(true);
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
		}
	});
});
