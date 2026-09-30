import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { parseReviewDiffSnapshot, type ReviewDiffSnapshot } from "./diff";

export type LocalReviewKind = "base-branch" | "uncommitted" | "commit";

/** Provenance of the compared revisions: the actual SHAs the diff was computed from. */
export interface ReviewScopeDetails {
	repositoryRoot: string;
	/** Merge base SHA — the actual comparison base for branch review. */
	baseSha?: string;
	/** Selected base branch label and its tip SHA, informational only. */
	baseLabel?: string;
	baseTipSha?: string;
	headLabel?: string;
	headSha?: string;
	commitSha?: string;
}

/** One frozen diff: the annotation view and the reviewer prompt both read this snapshot. */
export interface ResolvedReviewTarget {
	kind: LocalReviewKind | "pr";
	mode: string;
	rawDiff: string;
	snapshot: ReviewDiffSnapshot;
	emptyMessage: string;
	filteredMessage?: string;
	diffInstruction?: string;
	contextInstruction?: string;
	/** Provenance of the compared revisions, when the target is pinned to SHAs. */
	scope?: ReviewScopeDetails;
	/** Session-local reference to the persisted complete diff for large reviewable inputs. */
	fullDiffRef?: string;
}

export interface ReviewTargetUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{ label: string; kind: LocalReviewKind }> = [
	{ label: "1. Review against a base branch (PR Style)", kind: "base-branch" },
	{ label: "2. Review uncommitted changes", kind: "uncommitted" },
	{ label: "3. Review a specific commit", kind: "commit" },
];

const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

/** SHA-pinned diff instruction for merge-base branch review. */
export function buildBranchLargeDiffInstruction(mergeBaseSha: string, headSha: string): string {
	return `MUST run \`git diff ${mergeBaseSha} ${headSha} -- <path>\` for assigned files; NEVER review a moving branch name or run bare \`git diff\`/\`git show\``;
}

/** SHA-pinned diff instruction for single-commit review. */
export function buildCommitLargeDiffInstruction(sha: string): string {
	return `MUST run \`git show --first-parent ${sha} -- <path>\` for assigned files; NEVER review a moving branch name or run bare \`git show\``;
}

export function createResolvedReviewTarget(
	kind: ResolvedReviewTarget["kind"],
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "filteredMessage" | "diffInstruction" | "contextInstruction" | "scope"> = {},
): ResolvedReviewTarget {
	return {
		kind,
		mode,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
		emptyMessage,
		...options,
	};
}

export function getReviewTargetIssue(target: ResolvedReviewTarget): string | undefined {
	if (!target.rawDiff.trim()) return target.emptyMessage;
	if (target.snapshot.files.length === 0) {
		return target.filteredMessage ?? "No reviewable files (all changes filtered out)";
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read staged + unstaged (or jj working-copy) changes; throws when no repository is available. */
export async function readUncommittedReviewTarget(cwd: string): Promise<ResolvedReviewTarget> {
	const repository = vcs.require(cwd);
	const diffText = await repository.uncommittedDiff([]);
	const isJj = repository.kind() === "jj";
	return createResolvedReviewTarget(
		"uncommitted",
		isJj ? "Reviewing JJ working-copy changes" : "Reviewing uncommitted changes (staged + unstaged)",
		diffText,
		isJj || !diffText.trim() ? "No uncommitted changes found" : "No diff content found",
		{ diffInstruction: isJj ? JJ_UNCOMMITTED_DIFF_INSTRUCTION : GIT_UNCOMMITTED_DIFF_INSTRUCTION },
	);
}

async function listGitBranches(cwd: string): Promise<string[]> {
	try {
		return await vcs.requireGit(cwd).listBranches(true);
	} catch {
		return [];
	}
}

async function currentGitBranch(cwd: string): Promise<string> {
	try {
		return (await vcs.git(cwd)?.currentBranch()) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function recentCommits(cwd: string, count: number): Promise<string[]> {
	try {
		return await vcs.require(cwd).logOnelines(count);
	} catch {
		return [];
	}
}

export async function resolveLocalReviewTarget(
	kind: LocalReviewKind,
	cwd: string,
	ui: ReviewTargetUI,
): Promise<ResolvedReviewTarget | undefined> {
	switch (kind) {
		case "base-branch": {
			const branches = await listGitBranches(cwd);
			if (branches.length === 0) {
				ui.notify("No git branches found", "error");
				return undefined;
			}
			const baseBranch = await ui.select("Select base branch to compare against", branches);
			if (!baseBranch) return undefined;
			const currentBranch = await currentGitBranch(cwd);
			let diffText: string;
			let scope: ReviewScopeDetails;
			let diffInstruction: string;
			try {
				const repository = vcs.requireGit(cwd);
				// Resolve both tips to commits before diffing: the review is
				// pinned to these SHAs even if a branch moves during dispatch.
				const baseSha = await repository.resolveRef(baseBranch);
				const headSha = await repository.resolveRef(currentBranch);
				if (!baseSha || !headSha) {
					ui.notify(`Cannot resolve ${!baseSha ? baseBranch : currentBranch} to a commit`, "error");
					return undefined;
				}
				// PR-style review compares the merge base against the head
				// SHA (`base...head`), so base-only commits are excluded.
				const mergeBaseSha = await repository.mergeBase(baseSha, headSha);
				if (!mergeBaseSha) {
					// No common ancestor: `git diff base...head` aborts here
					// rather than comparing unrelated trees tip-to-tip.
					ui.notify(`No common history between ${baseBranch} and ${currentBranch}`, "error");
					return undefined;
				}
				diffText = await repository.diffText({ base: mergeBaseSha, head: headSha });
				scope = {
					repositoryRoot: repository.info().repoRoot,
					baseSha: mergeBaseSha,
					baseLabel: baseBranch,
					baseTipSha: baseSha,
					headLabel: currentBranch,
					headSha,
				};
				diffInstruction = buildBranchLargeDiffInstruction(mergeBaseSha, headSha);
			} catch (error) {
				ui.notify(`Failed to get diff: ${errorMessage(error)}`, "error");
				return undefined;
			}
			return createResolvedReviewTarget(
				"base-branch",
				`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
				diffText,
				`No changes between ${baseBranch} and ${currentBranch}`,
				{ diffInstruction, scope },
			);
		}
		case "uncommitted":
			try {
				return await readUncommittedReviewTarget(cwd);
			} catch (error) {
				ui.notify(`Failed to get diff: ${errorMessage(error)}`, "error");
				return undefined;
			}
		case "commit": {
			const commits = await recentCommits(cwd, 20);
			if (commits.length === 0) {
				ui.notify("No commits found", "error");
				return undefined;
			}
			const selectedCommit = await ui.select("Select commit to review", commits);
			if (!selectedCommit) return undefined;
			const hash = selectedCommit.split(" ")[0];
			let diffText: string;
			let resolvedSha: string;
			let scope: ReviewScopeDetails;
			let diffInstruction: string;
			try {
				const repository = vcs.requireGit(cwd);
				// Pin the review to the resolved commit; the menu's short hash
				// may be ambiguous and the commit must not drift.
				const sha = await repository.resolveRef(hash);
				if (!sha) {
					ui.notify(`Cannot resolve commit ${hash}`, "error");
					return undefined;
				}
				resolvedSha = sha;
				const result = await repository.showCommit(resolvedSha);
				diffText = result.data.toString("utf8");
				scope = { repositoryRoot: repository.info().repoRoot, commitSha: resolvedSha };
				diffInstruction = buildCommitLargeDiffInstruction(resolvedSha);
			} catch (error) {
				ui.notify(`Failed to get commit: ${errorMessage(error)}`, "error");
				return undefined;
			}
			return createResolvedReviewTarget(
				"commit",
				`Reviewing commit \`${resolvedSha}\``,
				diffText,
				"Commit has no diff content",
				{
					filteredMessage: "No reviewable files in commit (all changes filtered out)",
					diffInstruction,
					scope,
				},
			);
		}
	}
}
