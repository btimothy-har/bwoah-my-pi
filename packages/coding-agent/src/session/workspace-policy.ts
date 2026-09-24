/**
 * Workspace-policy classification for runtime reminders.
 *
 * Classifies the live execution directory as a primary checkout, a linked
 * execution worktree, a native isolated task sandbox, or unverified. This is
 * soft prompt guidance only: it grants or denies nothing by itself, and a
 * failed discovery classifies as unverified rather than as any writable state.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { directoryIsEnterable, normalizePathForComparison, prompt, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { normalizePromptPath } from "../utils/prompt-path";
import workspacePolicyReminderTemplate from "../prompts/system/workspace-policy-reminder.md" with { type: "text" };

export type WorkspacePolicyState =
	| { kind: "primary"; root: string }
	| { kind: "worktree"; root: string; primaryRoot: string }
	| { kind: "isolated"; root: string }
	| { kind: "unverified" };

/**
 * Classify `cwd` for workspace-policy guidance.
 *
 * Resolution order: enterability gate, native Git discovery, trusted
 * isolated-task-root match, then linked-worktree check. Never throws; a
 * discovery failure degrades to `unverified`. Branch names, HEAD state, and
 * path naming are never inspected; the isolated classification applies only
 * while execution remains inside the trusted isolated root.
 */
export async function resolveWorkspacePolicyState(
	cwd: string,
	isolatedTaskRoot?: string,
): Promise<WorkspacePolicyState> {
	if (!(await directoryIsEnterable(cwd))) return { kind: "unverified" };
	try {
		const nativeCwd = resolveEquivalentPath(cwd);
		const repo = vcs.git(nativeCwd);
		if (!repo) return { kind: "unverified" };
		const root = resolveEquivalentPath(repo.info().repoRoot);
		if (
			isolatedTaskRoot !== undefined &&
			normalizePathForComparison(root) === normalizePathForComparison(isolatedTaskRoot)
		) {
			return { kind: "isolated", root };
		}
		const linked = repo.linkedWorktree();
		if (linked) {
			return {
				kind: "worktree",
				root: resolveEquivalentPath(linked.root),
				primaryRoot: resolveEquivalentPath(linked.primaryRoot),
			};
		}
		return { kind: "primary", root };
	} catch {
		return { kind: "unverified" };
	}
}

/** Render the workspace-policy system reminder for the given state. */
export function renderWorkspacePolicyReminder(
	cwd: string,
	state: WorkspacePolicyState,
	hasRelatedDirectories = false,
): string {
	return prompt
		.render(workspacePolicyReminderTemplate, {
			kind: state.kind,
			cwd: normalizePromptPath(cwd),
			root: state.kind === "unverified" ? undefined : normalizePromptPath(state.root),
			primaryRoot: state.kind === "worktree" ? normalizePromptPath(state.primaryRoot) : undefined,
			hasRelatedDirectories,
		})
		.trim();
}
