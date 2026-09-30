/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve git root + capture baseline.
 *   2. {@link runIsolatedSubprocess}    — start worktree, run, capture
 *                                        changes, and transfer cleanup ownership.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call (the baseline is cloned per spawn
 * before mutation); steps 2 and 3 are per-spawn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreesDir, logger, prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import { trackLateCleanup } from "../utils/late-cleanup";
import { replaceFileAtomically } from "../utils/atomic-file";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import {
	needsNativeTeardown,
	readIsolationCleanup,
	writeIsolationCleanup,
	writeRetainedBackend,
	type IsolationCleanupAuthorization,
	type IsolationRecoveryArtifact,
} from "./isolation-ownership";
import { hasManagedDependents, isDetachedCopyBackend, withIsolationMetadataLock } from "./isolation-cleanup";
import type { NestedRepoPatch, SingleResult } from "@oh-my-pi/pi-tui/tools/task";

import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	type CommitToBranchResult,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

type IsoBackendKind = natives.IsoBackendKind;

/** Which isolation outcome `isolation-summary.md` should describe. */
export type IsolationSummaryKind =
	| "captured"
	| "capture-error"
	| "nested-apply-failed"
	| "not-applied"
	| "branch-merge-failed"
	| "branch-capture-failed"
	| "merge-error"
	| "discarded"
	| "unavailable";

/** Context for `isolation-summary.md`; unused fields are simply absent. */
export interface IsolationSummaryContext {
	kind: IsolationSummaryKind;
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths?: string[];
	error?: string;
	conflict?: string;
}

/**
 * Render one isolation outcome as the model-facing suffix appended to a task
 * result. Always starts with a blank line so it separates from the output it
 * follows.
 */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	return `\n\n${prompt.render(isolationSummaryTemplate, { ...context })}`;
}

/** Record artifact locations for `agent://` and mark the result as an isolated run. */
function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
	});
	return { ...result, isolated: true };
}

/**
 * Decide the fate of a half-built task branch after apply-back threw.
 *
 * Returns the branch name when it carries at least one commit past `baseSha`
 * — the caller must keep it, because the isolation worktree that also held
 * those objects is about to be torn down. Returns `undefined` after deleting
 * a branch that is absent, empty, or still pinned at the baseline, preserving
 * the original stale-branch cleanup for the cases where nothing is at stake.
 *
 * `revList.range` throws when the branch does not exist, which is the common
 * "commitToBranch failed before it created anything" path; that is treated as
 * "nothing to rescue" only after confirming the ref is absent. Other probe
 * failures preserve the branch because deleting it could lose the only reachable
 * copy of the agent's commits.
 */
async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	const repo = vcs.git(repoRoot);
	try {
		const carriedCommits = (await vcs.requireGit(repoRoot).revListRange(baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await repo?.refExists(`refs/heads/${branchName}`)) return branchName;
		} catch {
			// An inconclusive recovery probe must never risk deleting the only ref.
			return branchName;
		}
	}
	try {
		await repo?.deleteBranch(branchName, true);
	} catch {
		// Best-effort cleanup matches the old façade's tryDelete semantics.
	}
	return undefined;
}

/** Resolved repo and the baseline needed only for retained changes. */
export interface IsolationContext {
	repoRoot: string;
	baseline: WorktreeBaseline | null;
}

/** Resolve the Git root; discard runs skip the costly diff baseline. */
export async function prepareIsolationContext(
	cwd: string,
	options: { baseline: boolean } = { baseline: true },
): Promise<IsolationContext> {
	const repoRoot = await getRepoRoot(cwd);
	const baseline = options.baseline ? await captureBaseline(repoRoot) : null;
	return { repoRoot, baseline };
}
/** Probe repo availability without turning an implicit isolated spawn into a failure. */
export async function probeIsolationRepoRoot(cwd: string): Promise<{ repoRoot: string } | { unavailable: string }> {
	try {
		return { repoRoot: await getRepoRoot(cwd) };
	} catch (error) {
		return { unavailable: error instanceof Error ? error.message : String(error) };
	}
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = session.settings.get("task.isolation.commits");
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears prepared/path extension preloads and custom-tool paths
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. Baseline is cloned per spawn. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationBackend(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Never persist changes made in this clone. */
	discard: boolean;
	/** Output dir for `${agentId}.patch` artifacts (patch mode and branch-mode commit failures). */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
	/** Observe the real child result before post-run isolation work. */
	onSubprocessResult?: (result: SingleResult) => void;
	/**
	 * Record the published patch evidence with the artifact lease, so consumer
	 * cleanup can never delete the clone's recovery checkpoint.
	 */
	preserveRecoveryFiles?: (artifacts: readonly IsolationRecoveryArtifact[]) => void;
	/** Release the artifact lease's isolation hold after reclamation or retention handoff. */
	releaseArtifactHold?: () => Promise<void>;
}

/**
 * Write each nested-repo patch to `${artifactsDir}/${agentId}.nested-<n>-<path>.patch`
 * and return the paths. Throws on the first write failure: the caller must
 * then keep the isolation workspace alive, because it is the only other copy.
 * Every attempted destination is removed best-effort on failure — including
 * the in-progress file, which `Bun.write` may have created or truncated
 * before rejecting — so a half-written set cannot be mistaken for the
 * complete capture by the persisted-agent scanner.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const { nestedPatchPaths } = await publishNestedPatches(artifactsDir, agentId, nestedPatches);
	return nestedPatchPaths;
}

/** SHA-256 hex digest of in-memory artifact content. */
function digestArtifact(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * Publish nested-repo patches with staged sibling files replaced atomically.
 * A file whose destination already holds identical bytes is reused, so an
 * unchanged re-publication neither rewrites nor re-digests it.
 */
async function publishNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<{ nestedPatchPaths: string[]; artifacts: IsolationRecoveryArtifact[] }> {
	const saved: string[] = [];
	const artifacts: IsolationRecoveryArtifact[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			// Track before writing: a mid-write failure (ENOSPC, quota) can
			// leave a truncated file behind, and `force: true` makes removing
			// a never-created path a no-op.
			saved.push(destination);
			const existing = await Bun.file(destination)
				.text()
				.catch(() => undefined);
			if (existing !== nestedPatch.patch) {
				const staged = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
				await Bun.write(staged, nestedPatch.patch);
				await replaceFileAtomically(staged, destination);
			}
			artifacts.push({ path: destination, sha256: digestArtifact(nestedPatch.patch) });
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return { nestedPatchPaths: saved, artifacts };
}

interface IsolationPatchArtifacts {
	patchPath: string;
	hasRootChanges: boolean;
	nestedPatches: NestedRepoPatch[];
	nestedPatchPaths: string[];
	/** Published recovery evidence: every recovered file with its content digest. */
	artifacts: IsolationRecoveryArtifact[];
}

/**
 * Capture the isolation delta and publish every part of it to disk — the root
 * patch and one file per nested repo — before the caller tears the workspace
 * down. Throws when any write fails so nothing captured is ever the only copy.
 * A destination already holding identical bytes is reused instead of rewritten.
 */
async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationPatchArtifacts> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	const existingRoot = await Bun.file(patchPath)
		.text()
		.catch(() => undefined);
	if (existingRoot !== delta.rootPatch) {
		const staged = `${patchPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await Bun.write(staged, delta.rootPatch);
		await replaceFileAtomically(staged, patchPath);
	}
	const { nestedPatchPaths, artifacts } = await publishNestedPatches(artifactsDir, agentId, delta.nestedPatches);

	// The root patch is evidence even when empty: it proves the final delta
	// was computed and published after writer settlement.
	return {
		patchPath,
		hasRootChanges: delta.rootPatch.trim().length > 0,
		nestedPatches: delta.nestedPatches,
		nestedPatchPaths,
		artifacts: [{ path: patchPath, sha256: digestArtifact(delta.rootPatch) }, ...artifacts],
	};
}

/**
 * Move a retained isolation workspace out of its deterministic
 * (`repoRoot` + agent id) slot into a globally unique sibling, so a later
 * isolated run with the same id cannot wipe it: `ensureIsolation`
 * unconditionally removes the deterministic base dir before writing its
 * owner marker. The owner marker, `m` mount, and backend sidecar move along,
 * so `omp worktree clear` still classifies and reclaims the workspace with
 * native teardown. Backends needing it (mounts, Btrfs subvolumes) record the
 * sidecar BEFORE the move so it travels atomically — a crash between rename
 * and a later write would leave a mounted workspace with a dead owner and
 * no metadata, and cleanup would traverse the live mount.
 */
export interface RetainedWorkspace {
	/** Workspace path to report (unique sibling on success, original dir when the move fails). */
	dir: string;
	/**
	 * False when cleanup metadata is missing that `clear` would need: the
	 * sidecar could not be written (plausible under the same disk pressure
	 * that forced retention). The error must then say the mount needs a
	 * manual unmount instead of advertising plain `worktree clear`.
	 */
	sidecarOk: boolean;
}

/** Result fields from a published patch, excluding the GC evidence array. */
function patchResultFields(
	patchResult: IsolationPatchArtifacts,
): Pick<IsolationPatchArtifacts, "patchPath" | "hasRootChanges" | "nestedPatches" | "nestedPatchPaths"> {
	return {
		patchPath: patchResult.patchPath,
		hasRootChanges: patchResult.hasRootChanges,
		nestedPatches: patchResult.nestedPatches,
		nestedPatchPaths: patchResult.nestedPatchPaths,
	};
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend?: natives.IsoBackendKind,
): Promise<RetainedWorkspace> {
	const baseDir = path.dirname(isolationDir);
	const root = path.resolve(getWorktreesDir());
	await fs.mkdir(root, { recursive: true });
	const record = await readIsolationCleanup(baseDir).catch(() => undefined);
	const needsSidecar = backend !== undefined && needsNativeTeardown(backend);
	let sidecarOk = !needsSidecar;
	if (needsSidecar && backend !== undefined) {
		try {
			await writeRetainedBackend(baseDir, backend);
			sidecarOk = true;
		} catch {
			sidecarOk = false;
		}
	}
	// A source with surviving dependents must be retained IN PLACE: renaming it
	// breaks the dependent's object borrows. A mount/path-indexed backend must
	// also stay at its recorded path. Mark `retained` (never auto-reclaimed)
	// before any relocation, and let a record-less legacy wrapper relocate as
	// before — the manual `clear` path owns its teardown.
	const pinned = await hasManagedDependents(root, baseDir).catch(() => true);
	const renameSafe = backend === undefined || (isDetachedCopyBackend(backend, record) && !pinned);
	if (record) {
		await withIsolationMetadataLock(root, async () => {
			await writeIsolationCleanup(baseDir, { ...record, state: "retained" });
		});
	}
	if (!renameSafe) return { dir: isolationDir, sidecarOk };
	// A valid move can still fail transiently (Windows AV/indexer locks);
	// retry briefly before conceding the deterministic slot.
	const retainedBase = `${baseDir}.retained-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rename(baseDir, retainedBase);
			return { dir: path.join(retainedBase, path.basename(isolationDir)), sidecarOk };
		} catch {
			if (attempt === 2) return { dir: isolationDir, sidecarOk };
			await Bun.sleep(25);
		}
	}
	return { dir: isolationDir, sidecarOk };
}
/** Context for `isolation-error.md`: the `result.error` text for a run whose changes could not be captured or landed. */
interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	/** Set when the workspace was kept because its changes could not be written out. */
	retainedDir?: string;
	/**
	 * Set when the retained mount's unmount metadata is missing: cleanup
	 * cannot unmount before removal, so the message must direct a manual
	 * unmount instead of advertising plain `worktree clear`.
	 */
	sidecarMissing?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches` (+ `nestedPatchPaths`). On commit
 * failure the still-live isolation diff is written to
 * `${artifactsDir}/${agentId}.patch`, the task branch is kept when it already
 * carries commits (deleted otherwise), and `result.error` carries the
 * merge-failure message plus recovery hint.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` plus one
 * `${agentId}.nested-<n>-<path>.patch` per nested repo and returns
 * `patchPath` + `nestedPatches` + `nestedPatchPaths`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * Kept-alive runs retain the isolation handle through idle/parked lifecycle
 * transitions, then capture final changes and clean up on release. One-shot
 * and failed startup paths clean up in `finally`. If captured changes cannot
 * be written to disk, the workspace is retained under a unique `.retained-*`
 * sibling and its path is named in the resulting error.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	const taskBaseline = structuredClone(opts.context.baseline);
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	let retainWorkspace = false;
	let releaseRequested = false;
	let initialExecutionDone = false;
	let lastPublished: IsolationPatchArtifacts | undefined;
	let baseReleasePromise: Promise<void> | undefined;
	let finalizePromise: Promise<void> | undefined;
	let reclaimPromise: Promise<void> | undefined;
	let releasePromise: Promise<void> | undefined;
	const releaseBase = (): Promise<void> => {
		baseReleasePromise ??= opts.baseOptions.onRelease?.() ?? Promise.resolve();
		return baseReleasePromise;
	};
	/**
	 * Publish the final cumulative snapshot against the original baseline.
	 * Never merges, deletes the clone, or creates a recovery branch; a capture
	 * failure retains the workspace and fails finalization.
	 */
	const finalizeSnapshot = (): Promise<void> => {
		finalizePromise ??= (async () => {
			if (!handle || retainWorkspace || opts.discard) return;
			const baseline = taskBaseline as WorktreeBaseline;
			let patchResult: IsolationPatchArtifacts;
			try {
				patchResult = await writeIsolationPatch(handle.mergedDir, baseline, opts.artifactsDir, opts.agentId);
			} catch (captureErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(handle.mergedDir, handle.backend);
				throw new Error(
					renderIsolationError({
						kind: "patch-capture-failed",
						message: captureErr instanceof Error ? captureErr.message : String(captureErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				);
			}
			lastPublished = patchResult;
			AgentRegistry.global().setHistory(opts.agentId, {
				patchPath: patchResult.patchPath,
				nestedPatchPaths: patchResult.nestedPatchPaths,
			});
			opts.preserveRecoveryFiles?.(patchResult.artifacts);
		})();
		return finalizePromise;
	};
	/** Consume a published snapshot: record `ready` with authorization and reclaim. */
	const reclaimWorkspace = (): Promise<void> => {
		reclaimPromise ??= (async () => {
			try {
				if (handle && !retainWorkspace) {
					const authorization: IsolationCleanupAuthorization = opts.discard
						? { kind: "discard" }
						: { kind: "snapshot", artifacts: lastPublishedArtifacts() };
					await cleanupIsolation(handle, authorization);
				}
			} finally {
				await opts.releaseArtifactHold?.();
			}
		})();
		return reclaimPromise;
	};
	const lastPublishedArtifacts = (): IsolationRecoveryArtifact[] => {
		if (!lastPublished) throw new Error("Final snapshot must be published before workspace reclamation.");
		return lastPublished.artifacts;
	};
	const releaseSequence = async (): Promise<void> => {
		await finalizeSnapshot();
		await releaseBase();
		await reclaimWorkspace();
	};
	/**
	 * Lifecycle-owned release. The executor can invoke this from inside initial
	 * `runSubprocess` teardown, before the outer runner has settled its writer
	 * barrier — in that case only record the request; the outer `finally`
	 * finishes finalization/reclamation after the barrier. Awaiting the outer
	 * completion here would deadlock against `finalizeSubagentLifecycle`.
	 */
	const releaseIsolation = (): Promise<void> => {
		releaseRequested = true;
		if (!initialExecutionDone) return Promise.resolve();
		releasePromise ??= releaseSequence();
		return releasePromise;
	};
	const oneShotSequence = async (): Promise<void> => {
		try {
			await releaseBase();
			if (!handle || retainWorkspace) return;
			const authorization: IsolationCleanupAuthorization = opts.discard
				? { kind: "discard" }
				: lastPublished
					? { kind: "snapshot", artifacts: lastPublished.artifacts }
					: { kind: "explicit" };
			await cleanupIsolation(handle, authorization);
		} finally {
			await opts.releaseArtifactHold?.();
		}
	};
	try {
		if (!opts.discard && !taskBaseline) throw new Error("Isolation baseline is required to capture changes.");
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const isolationBackend = handle.backend;
		// Persist the discard disposition before execution so a crash leaves a
		// record that authorizes cleanup without any recovery evidence.
		if (opts.discard) {
			await withIsolationMetadataLock(path.resolve(getWorktreesDir()), async () => {
				const record = await readIsolationCleanup(path.dirname(isolationDir)).catch(() => undefined);
				if (record && record.disposition !== "discard") {
					await writeIsolationCleanup(path.dirname(isolationDir), { ...record, disposition: "discard" });
				}
			});
		}
		const result = await runSubprocess({
			...opts.baseOptions,
			discardChanges: opts.discard,
			parentRepoRoot: opts.context.repoRoot,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
			// One-shot runs get `releaseBase` (never touches the worktree): their
			// `finalizeSubagentLifecycle` calls `onRelease` before this function's
			// post-run capture, so the handle must survive until the `finally`
			// below cleans it up. Only kept-alive runs hand full capture+cleanup
			// (`releaseIsolation`) to the agent lifecycle.
			onRelease: opts.baseOptions.keepAlive === false ? releaseBase : releaseIsolation,
		});
		opts.onSubprocessResult?.(result);
		// From here the outer runner owns post-run isolation work; a release
		// requested by the lifecycle before this point is completed below.
		initialExecutionDone = true;
		// A successful result cannot be captured while deferred owner jobs or
		// shutdown hooks may still write the worktree. Failed runs skip capture,
		// so their cleanup remains asynchronous.
		if (deferredCleanup && result.exitCode === 0) {
			await deferredCleanup;
		}
		if (opts.discard) return rememberAgentArtifacts(result);
		const baseline = taskBaseline as WorktreeBaseline;
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			let commitResult: CommitToBranchResult | null;
			// Backup before branch construction: the patch (not just the branch)
			// must survive the clone's deletion, per the patch-only recovery rule.
			try {
				lastPublished = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
				opts.preserveRecoveryFiles?.(lastPublished.artifacts);
			} catch (backupErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: backupErr instanceof Error ? backupErr.message : String(backupErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
			try {
				commitResult = await commitToBranch(
					isolationDir,
					baseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
			} catch (mergeErr) {
				// Agent succeeded but the branch commit failed. `commitToBranch`
				// is not atomic: the clean-baseline path fetches the agent's
				// commits into the parent ODB and creates `omp/task/<id>` before
				// it commits the leftover working-tree delta, so a throw from
				// that trailing step leaves behind a branch that already holds
				// every commit the agent made. The isolation worktree — the only
				// other copy of those objects — is destroyed by the `finally`
				// below, so deleting the branch unconditionally turned a
				// recoverable merge conflict into permanent loss of committed
				// work (#8868). Delete only when nothing is at stake.
				const baseSha = baseline.root.headCommit;
				const branchName = `omp/task/${opts.agentId}`;
				const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const patchResult = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
					return rememberAgentArtifacts({
						...result,
						...patchResultFields(patchResult),
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					});
				} catch (patchErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
					return rememberAgentArtifacts({
						...result,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					});
				}
			}
			// The branch holds the root-repo work, but nested-repo patches exist
			// only in memory until written; the workspace goes away in `finally`.
			try {
				const nestedPatchPaths = await persistNestedPatches(
					opts.artifactsDir,
					opts.agentId,
					commitResult?.nestedPatches ?? [],
				);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					nestedPatchPaths,
				});
			} catch (persistErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					error: renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		if (result.exitCode === 0) {
			try {
				const patchResult = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
				return rememberAgentArtifacts({ ...result, ...patchResultFields(patchResult) });
			} catch (patchErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: patchErr instanceof Error ? patchErr.message : String(patchErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		return rememberAgentArtifacts(result);
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		// Setup never completed: no clone exists, so the artifact hold transfers
		// back to the consumer immediately.
		if (!handle) await opts.releaseArtifactHold?.();
		const adopted = opts.baseOptions.keepAlive !== false && AgentLifecycleManager.global().has(opts.agentId);
		if (handle && !retainWorkspace && !reclaimPromise && !(adopted && !releaseRequested)) {
			const runSequence = async (): Promise<void> => {
				if (deferredCleanup) {
					try {
						await deferredCleanup;
					} catch (error) {
						// Writer settlement failed: the workspace holds unproven
						// state and is never reclaimed.
						retainWorkspace = true;
						logger.warn("deferred isolation cleanup failed; workspace preserved", {
							agentId: opts.agentId,
							error: error instanceof Error ? error.message : String(error),
						});
						await releaseBase();
						return;
					}
				}
				await (adopted || releaseRequested ? releaseSequence() : oneShotSequence());
			};
			if (deferredCleanup) {
				trackLateCleanup(runSequence(), {
					agentId: opts.agentId,
					resource: "isolation",
				});
			} else {
				await runSequence();
			}
		}
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo: patch apply (patch mode) or cherry-pick + cleanup (branch mode).
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	const repo = vcs.requireGit(repoRoot);
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				return {
					summary: renderIsolationSummary({
						kind: "branch-capture-failed",
						error: result.error,
						rootPatchPath: result.patchPath,
						nestedPatchPaths: result.nestedPatchPaths,
					}),
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				// The nested patches are skipped when the branch did not merge; name
				// their files so the parent can recover them alongside the branch.
				summary = renderIsolationSummary({
					kind: "branch-merge-failed",
					branchName: result.branchName,
					conflict: mergeResult.conflict,
					nestedPatchPaths: result.nestedPatchPaths,
				});
			}
			if (mergeResult.stashConflict) {
				summary += `\n\n<system-notification>${mergeResult.stashConflict}</system-notification>`;
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
					repo.canApplyPatch(normalized, {}).catch(() => false),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await repo.applyPatch(normalized, {});
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			// Nested apply is skipped when the root patch did not apply; the
			// persisted nested patches are the parent's only pointer to that work.
			summary = renderIsolationSummary({
				kind: "not-applied",
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			});
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		return {
			summary: renderIsolationSummary({
				kind: "merge-error",
				error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
				branchName: result.branchName,
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			}),
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

/**
 * Apply nested-repo patches after the parent merge phase. Centralizes the
 * three-way gate (exitCode/aborted, patch-mode failed parent, branch-mode
 * branch-merged) and the non-fatal failure handling so `TaskTool` and the
 * eval `agent()` bridge use one implementation.
 *
 * Returns a system-notification suffix to append to the parent merge summary,
 * or an empty string when nothing was applied or the nested apply succeeded.
 */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch (applyErr) {
		// Nested patch failures are non-fatal to the parent merge, but the patch
		// files are the only surviving copy of that work — name them.
		return renderIsolationSummary({
			kind: "nested-apply-failed",
			error: applyErr instanceof Error ? applyErr.message : String(applyErr),
			nestedPatchPaths: result.nestedPatchPaths,
		});
	}
}
