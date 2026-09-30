/**
 * Automatic reclamation of task-isolation workspaces whose owning process is
 * gone and whose changes are provably saved (or never existed).
 *
 * Safety model, enforced here for every entry:
 * - Only wrappers carrying a valid `.omp-isolation-cleanup.json` record are
 *   candidates. Legacy, unmarked, or corrupt sandboxes are reported `kept` —
 *   the manual `omp worktree clear` path owns those.
 * - `ready` requires the recorded patch evidence (path + SHA-256) to verify.
 *   Verification failure preserves the workspace.
 * - The original owner must be positively dead (`readIsolationOwner` +
 *   `isIsolationOwnerLive`); a missing/malformed owner marker is unknown, not
 *   dead, and is preserved.
 * - A `claim` names the collector currently deleting an entry. Competing
 *   collectors (across or within processes) skip live claims; a dead claim is
 *   resumed only after re-validating generation and authorization.
 * - A dependent workspace (nested clone borrowing its source's object
 *   database) pins its source: sources are reclaimed only after every
 *   dependent is actually removed.
 * - Detached copy backends (APFS/reflink/block-clone/rcopy) are renamed into
 *   `<root>/.trash/` before deletion; a not-yet-detached copy backend and
 *   mount/path-indexed backends (overlayfs, projfs, ZFS, Btrfs) are torn down
 *   at their original path and never moved.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import {
	currentIsolationClaim,
	isIsolationOwnerLive,
	ISOLATION_CLEANUP_FILE,
	ISOLATION_OWNER_FILE,
	ISOLATION_SEGMENT_PATTERN,
	RETAINED_BACKEND_FILE,
	readIsolationCleanup,
	readIsolationOwner,
	writeIsolationCleanup,
	writeIsolationOwner,
	type IsolationCleanupRecord,
} from "./isolation-ownership";
/**
 * Directories inside an isolation wrapper holding the merged working view.
 * `m` is the canonical name built by worktree.ts's TASK_ISOLATION_MOUNT_DIR;
 * `merged` is the legacy layout still recognized by manual `worktree clear`.
 */
export const ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

/** Reserved relocation target; entries here are already release-authorized. */
export const ISOLATION_TRASH_DIR = ".trash";

/** Path stem for the worktree-root metadata lock (`.lock` is appended by the lock helper). */
export const ISOLATION_GC_LOCK_STEM = ".isolation-gc";

/** How the collector selects candidates. */
export type IsolationCleanupOwnerFilter = "dead" | "released-current";

export interface IsolationCleanupOptions {
	owner: IsolationCleanupOwnerFilter;
	/** Absolute time bounds for dispatch and waiting; unstarted work is reported kept. */
	deadlineAt?: number;
}

export interface IsolationCleanupReport {
	removed: number;
	kept: number;
	failed: number;
}

interface WrapperObservation {
	/** Wrapper directory at discovery time (inside root or trash). */
	dir: string;
	record: IsolationCleanupRecord | undefined;
	/** True when `m`/`merged` exists with a `.git` payload. */
	hasPayload: boolean;
	/** Managed wrapper recorded as this workspace's source, when known. */
	sourceBaseDir: string | undefined;
}

interface EntryVerdict {
	eligible: boolean;
	reason: string;
}

const scheduledRoots = new Set<string>();

/**
 * Schedule one background dead-owner collection pass for `root`. Calling is
 * cheap and never touches the filesystem; the actual scan starts on the next
 * macrotask and is never awaited. Coalesced per canonical root per process.
 */
export function scheduleIsolationCleanup(root: string): void {
	const canonical = path.resolve(root);
	if (scheduledRoots.has(canonical)) return;
	scheduledRoots.add(canonical);
	const job = setImmediate(() => {
		collectIsolationCleanup(canonical, { owner: "dead" }).catch(error => {
			logger.warn("isolation cleanup sweep failed", { root: canonical, error: String(error) });
		});
	});
	job.unref?.();
}

/**
 * Collect eligible isolation workspaces under `root`. Never captures work:
 * entries without a validated cleanup record and verified evidence are kept.
 */
export async function collectIsolationCleanup(
	root: string,
	options: IsolationCleanupOptions,
): Promise<IsolationCleanupReport> {
	const resolvedRoot = await resolveManagedRoot(root);
	if (!resolvedRoot) return { removed: 0, kept: 0, failed: 0 };
	const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
	const observations = await observeWrappers(resolvedRoot);
	const verdicts = await evaluateEntries(resolvedRoot, observations, options);

	// Child-before-source by fixed point: dependency direction is unknown for
	// same-depth wrappers (a nested clone and its source are both direct root
	// children), so a source deferred as pinned in one round is retried after
	// its dependent is removed in that round.
	const removalOrder = orderEntries(resolvedRoot, observations);
	const pending = new Set(removalOrder.map(entry => entry.dir));
	const removedDirs = new Set<string>();
	let removed = 0;
	let failed = 0;
	let progress = true;
	const deadline = Promise.withResolvers<void>();
	// setTimeout coerces non-finite delays to 1ms — arm only a real budget.
	const deadlineTimer = Number.isFinite(deadlineAt)
		? setTimeout(() => deadline.resolve(), Math.max(0, deadlineAt - Date.now()))
		: undefined;
	deadlineTimer?.unref?.();
	try {
		while (progress && Date.now() < deadlineAt) {
			progress = false;
			for (const entry of removalOrder) {
				if (Date.now() >= deadlineAt) break;
				if (!pending.has(entry.dir)) continue;
				const verdict = verdicts.get(entry.dir);
				if (!verdict?.eligible) continue;
				if (await isPinnedByDependent(resolvedRoot, entry, observations, removedDirs)) {
					logger.debug("isolation cleanup skipping pinned source", {
						dir: entry.dir,
						generation: entry.record?.generation,
					});
					continue;
				}
				pending.delete(entry.dir);
				try {
					// The deadline bounds waiting on in-flight teardown, never the
					// teardown itself: on expiry the actual completion is registered
					// with trackLateCleanup and the entry counts as kept.
					const outcome = await Promise.race([
						reclaimEntry(resolvedRoot, entry),
						deadline.promise.then((): "removed" | "kept" => "kept"),
					]);
					if (outcome === "removed") {
						removedDirs.add(entry.dir);
						removed += 1;
						progress = true;
					}
				} catch (error) {
					failed += 1;
					logger.warn("isolation cleanup entry failed", {
						dir: entry.dir,
						generation: entry.record?.generation,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	} finally {
		clearTimeout(deadlineTimer);
	}
	// Kept = never attempted + attempted-but-not-removed + skipped by verdict.
	for (const entry of removalOrder) {
		if (verdicts.get(entry.dir)?.eligible && !pending.has(entry.dir) && !removedDirs.has(entry.dir)) {
			logger.debug("isolation cleanup kept entry", {
				dir: entry.dir,
				generation: entry.record?.generation,
				reason: verdicts.get(entry.dir)?.reason,
			});
		}
	}
	const kept = observations.length - removed - failed;
	logger.debug("isolation cleanup pass complete", {
		root: resolvedRoot,
		removed,
		kept,
		failed,
		owner: options.owner,
	});
	return { removed, kept, failed };
}

/** Canonicalize and validate the configured worktree root; `undefined` when absent. */
async function resolveManagedRoot(root: string): Promise<string | undefined> {
	let stat: Stats;
	try {
		stat = await fs.lstat(root);
	} catch {
		return undefined;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
	return fs.realpath(root);
}

/** Enumerate direct wrappers and trash children without following symlinks. */
async function observeWrappers(root: string): Promise<WrapperObservation[]> {
	const observations: WrapperObservation[] = [];
	for (const dir of await listCandidateWrappers(root)) {
		observations.push(await observeWrapper(dir));
	}
	return observations;
}

async function listCandidateWrappers(root: string): Promise<string[]> {
	const names = await fs.readdir(root).catch(() => []);
	const wrappers: string[] = [];
	for (const name of names) {
		const dir = path.join(root, name);
		const stat = await fs.lstat(dir).catch(() => undefined);
		if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
		if (name === ISOLATION_TRASH_DIR) {
			const trashNames = await fs.readdir(dir).catch(() => []);
			for (const trashName of trashNames) {
				if (trashName.startsWith(".")) continue;
				const trashChild = path.join(dir, trashName);
				const trashStat = await fs.lstat(trashChild).catch(() => undefined);
				if (trashStat?.isDirectory() && !trashStat.isSymbolicLink()) wrappers.push(trashChild);
			}
			continue;
		}
		if (name.startsWith(".") || name.includes(".lock")) continue;
		if (ISOLATION_SEGMENT_PATTERN.test(name)) wrappers.push(dir);
	}
	return wrappers;
}

async function observeWrapper(dir: string): Promise<WrapperObservation> {
	const record = await readIsolationCleanup(dir).catch(() => undefined);
	let hasPayload = false;
	for (const mountDir of ISOLATION_MOUNT_DIRS) {
		const merged = path.join(dir, mountDir);
		const stat = await fs.lstat(merged).catch(() => undefined);
		if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
		hasPayload = await fs
			.lstat(path.join(merged, ".git"))
			.then(() => true)
			.catch(() => false);
		if (hasPayload) break;
	}
	return { dir, record, hasPayload, sourceBaseDir: record?.sourceBaseDir };
}

/**
 * Decide reclaim eligibility for every wrapper. Dependency pinning is decided
 * later, per entry, in the processing loop (a dependent removed earlier in the
 * same pass unpins its source).
 */
async function evaluateEntries(
	root: string,
	observations: WrapperObservation[],
	options: IsolationCleanupOptions,
): Promise<Map<string, EntryVerdict>> {
	const verdicts = new Map<string, EntryVerdict>();
	for (const observation of observations) {
		verdicts.set(observation.dir, await evaluateEntry(root, observation, options));
	}
	return verdicts;
}

async function evaluateEntry(
	root: string,
	observation: WrapperObservation,
	options: IsolationCleanupOptions,
): Promise<EntryVerdict> {
	const { record } = observation;
	if (!record) return { eligible: false, reason: "no valid cleanup record" };

	// A live collector claim blocks re-entry, including from this same process;
	// resuming a dead claim re-validates the generation in claimForTeardown.
	if (record.claim && (await isIsolationOwnerLive(record.claim))) {
		return { eligible: false, reason: `live collector claim pid ${record.claim.pid}` };
	}

	const owner = await readIsolationOwner(observation.dir).catch(() => undefined);
	const ownerProvenDead = owner !== undefined && !(await isIsolationOwnerLive(owner));
	const ownerAbsent = owner === undefined;
	if (!ownerProvenDead && !(ownerAbsent && inTrash(root, observation.dir))) {
		return { eligible: false, reason: "original owner live or unverifiable" };
	}
	if (options.owner === "released-current") {
		// Only this process's released generations: a live claim from this
		// process is already rejected above; a dead-owner entry from another
		// process is left for the startup "dead" pass.
		if (owner && owner.pid !== process.pid) return { eligible: false, reason: "owned by another process" };
	}

	if (record.state === "retained") return { eligible: false, reason: "intentional recovery retention" };
	if (record.state === "active") {
		// An active record with a dead owner is a crashed run: never auto-delete.
		return { eligible: false, reason: "crashed active generation" };
	}
	if (record.state === "finalizing") {
		return { eligible: false, reason: "finalization interrupted" };
	}

	const authorization = record.authorization;
	if (!authorization) return { eligible: false, reason: "no cleanup authorization" };
	if (authorization.kind === "snapshot") {
		const evidenceOk = await verifyIsolationRecoveryArtifacts(authorization.artifacts);
		if (!evidenceOk) return { eligible: false, reason: "patch evidence missing or altered" };
	}

	return { eligible: true, reason: "authorized" };
}

/** Verify every recorded artifact exists at its recorded path with matching bytes. */
export async function verifyIsolationRecoveryArtifacts(
	artifacts: readonly { path: string; sha256: string }[],
): Promise<boolean> {
	if (artifacts.length === 0) return false;
	for (const artifact of artifacts) {
		const stat = await fs.lstat(artifact.path).catch(() => undefined);
		if (!stat?.isFile()) return false;
		const digest = new Bun.CryptoHasher("sha256");
		const stream = Bun.file(artifact.path).stream();
		for await (const chunk of stream) digest.update(chunk);
		if (digest.digest("hex") !== artifact.sha256) return false;
	}
	return true;
}

/**
 * Whether `backend` is an ordinary-copy backend whose wrapper may be renamed:
 * detached per its record, or record-less (legacy shells the manual `clear`
 * path already relocates).
 */
export function isDetachedCopyBackend(backend: number, record: IsolationCleanupRecord | undefined): boolean {
	if (!isRenameSafeBackend(backend)) return false;
	return record ? record.detached : true;
}

/**
 * Managed wrapper paths a payload-bearing dependent's object store may borrow
 * from: the recorded `sourceBaseDir`, or — for record-less legacy clones —
 * every root-local path named in the clone's git alternates file.
 */
async function dependencySourcesFor(root: string, dependent: WrapperObservation): Promise<string[]> {
	if (dependent.sourceBaseDir) return [dependent.sourceBaseDir];
	if (!dependent.hasPayload) return [];
	const sources: string[] = [];
	for (const mountDir of ISOLATION_MOUNT_DIRS) {
		const alternatesPath = path.join(dependent.dir, mountDir, ".git", "objects", "info", "alternates");
		const text = await Bun.file(alternatesPath)
			.text()
			.catch(() => undefined);
		if (text === undefined) continue;
		for (const line of text.split("\n")) {
			const entry = line.trim();
			if (!entry) continue;
			const resolved = path.resolve(dependent.dir, entry);
			if (`${resolved}${path.sep}`.startsWith(`${root}${path.sep}`)) sources.push(resolved);
		}
	}
	return sources;
}

/**
 * Path equality through symlinks: macOS `/tmp` → `/private/tmp` and similar
 * links make lexical comparison lie. Falls back to lexical equality when a
 * path cannot be resolved.
 */
async function pathsEqual(a: string, b: string): Promise<boolean> {
	const [realA, realB] = await Promise.all([
		fs.realpath(a).catch(() => path.resolve(a)),
		fs.realpath(b).catch(() => path.resolve(b)),
	]);
	return realA === realB;
}

/**
 * Deepest-first ordering for teardown: dependents are decided before their
 * sources. Shared with `worktree clear`'s target ordering so manual and
 * automatic collection never disagree.
 */
export function compareDependentsFirst(a: string, b: string): number {
	return b.split(path.sep).length - a.split(path.sep).length;
}

function orderEntries(root: string, observations: WrapperObservation[]): WrapperObservation[] {
	return [...observations].sort((a, b) => compareDependentsFirst(a.dir, b.dir));
}

/**
 * Whether any surviving payload-bearing workspace borrows `source`'s object
 * store. A dependent already removed earlier in this pass no longer pins;
 * kept or failed dependents do.
 */
async function isPinnedByDependent(
	root: string,
	source: WrapperObservation,
	observations: WrapperObservation[],
	removedDirs: ReadonlySet<string>,
): Promise<boolean> {
	for (const dependent of observations) {
		if (dependent.dir === source.dir) continue;
		if (removedDirs.has(dependent.dir)) continue;
		if (!dependent.hasPayload) continue; // marker-only wrapper: no object-store dependency
		const sources = await dependencySourcesFor(root, dependent);
		for (const sourceDir of sources) {
			if (await pathsEqual(sourceDir, source.dir)) return true;
		}
	}
	return false;
}

/**
 * Whether any payload-bearing workspace under `root` borrows `baseDir`'s
 * object store — via a declared `sourceBaseDir` or legacy git alternates.
 * A source with surviving dependents must not be renamed or removed.
 */
export async function hasManagedDependents(root: string, baseDir: string): Promise<boolean> {
	const resolvedRoot = await resolveManagedRoot(root);
	if (!resolvedRoot) return false;
	const observations = await observeWrappers(resolvedRoot);
	for (const dependent of observations) {
		if (await pathsEqual(dependent.dir, baseDir)) continue;
		if (!dependent.hasPayload) continue;
		const sources = await dependencySourcesFor(resolvedRoot, dependent);
		for (const sourceDir of sources) {
			if (await pathsEqual(sourceDir, baseDir)) return true;
		}
	}
	return false;
}

/**
 * Reclaim one authorized entry: claim it under the root lock, tear it down at
 * the appropriate path, and clear the claim when the destructive work settled.
 */
async function reclaimEntry(root: string, observation: WrapperObservation): Promise<"removed" | "kept"> {
	const record = observation.record;
	if (!record) return "kept";
	const claimed = await claimForTeardown(root, observation.dir, record.generation);
	if (!claimed) return "kept";
	return teardownClaimedWrapper(root, observation.dir, claimed);
}

/**
 * Claim an entry for physical teardown under the root metadata lock: re-read
 * the record, verify the generation, and install this collector's claim.
 * Returns the claimed record, or `undefined` when another live collector owns
 * the entry or the generation changed.
 */
async function claimForTeardown(
	root: string,
	dir: string,
	generation: string,
): Promise<IsolationCleanupRecord | undefined> {
	return withIsolationMetadataLock(
		root,
		async () => {
			const current = await readIsolationCleanup(dir).catch(() => undefined);
			if (!current || current.generation !== generation) return undefined;
			if (current.claim && (await isIsolationOwnerLive(current.claim))) return undefined;
			await writeIsolationCleanup(dir, {
				...current,
				state: inTrash(root, dir) ? "trash" : "deleting",
				claim: await currentIsolationClaim(),
			});
			return current;
		},
		{ retries: 1 },
	).catch(error => {
		if (isLockContention(error)) {
			logger.debug("isolation cleanup lock contended; skipping entry", { root, dir });
			return undefined;
		}
		throw error;
	});
}

function inTrash(root: string, dir: string): boolean {
	const trashRoot = path.join(root, ISOLATION_TRASH_DIR);
	return dir === trashRoot || dir.startsWith(`${trashRoot}${path.sep}`);
}

/**
 * Physical teardown for a claimed, authorized wrapper. Payload (including the
 * mount itself) is removed before the owner/cleanup marker files, so a crash
 * mid-deletion always leaves resumable metadata behind.
 */
async function teardownClaimedWrapper(
	root: string,
	dir: string,
	record: IsolationCleanupRecord,
): Promise<"removed" | "kept"> {
	try {
		let finalDir = dir;
		// Copy backends hold no path-indexed mount state: rename first, then
		// remove recursively. Their stop routines delete data themselves and
		// must never be routed through isoStop.
		if (isRenameSafeBackend(record.backend) && record.detached && !inTrash(root, dir)) {
			const trash = path.join(root, ISOLATION_TRASH_DIR, `${path.basename(dir)}.${record.generation}`);
			await fs.mkdir(path.join(root, ISOLATION_TRASH_DIR), { recursive: true });
			await fs.rename(dir, trash);
			finalDir = trash;
		}
		const merged = await findMergedDir(finalDir);
		if (merged && isMountBackend(record.backend)) {
			await natives.isoStop(record.backend, merged);
		}
		await removeWrapperPreservingMarkers(finalDir);
		return "removed";
	} catch (error) {
		if (isEnoent(error)) {
			// Another collector removed the same generation first: benign no-op.
			return "kept";
		}
		await restoreRetryableRecord(root, dir, record);
		logger.warn("isolation cleanup teardown failed; workspace preserved", {
			dir,
			generation: record.generation,
			error: error instanceof Error ? error.message : String(error),
		});
		return "kept";
	}
}

function isRenameSafeBackend(backend: number): boolean {
	return (
		backend === natives.IsoBackendKind.Apfs ||
		backend === natives.IsoBackendKind.LinuxReflink ||
		backend === natives.IsoBackendKind.WindowsBlockClone ||
		backend === natives.IsoBackendKind.Rcopy
	);
}

/** Backends whose teardown is path-indexed: stop at the original path, never after a rename. */
function isMountBackend(backend: number): boolean {
	return (
		backend === natives.IsoBackendKind.Overlayfs ||
		backend === natives.IsoBackendKind.Projfs ||
		backend === natives.IsoBackendKind.Zfs ||
		backend === natives.IsoBackendKind.Btrfs
	);
}

async function findMergedDir(dir: string): Promise<string | undefined> {
	for (const mountDir of ISOLATION_MOUNT_DIRS) {
		const merged = path.join(dir, mountDir);
		const stat = await fs.lstat(merged).catch(() => undefined);
		if (stat?.isDirectory() && !stat.isSymbolicLink()) return merged;
	}
	return undefined;
}

/** Remove everything under the wrapper except the control metadata files. */
async function removeWrapperPreservingMarkers(dir: string): Promise<void> {
	const markers = [ISOLATION_OWNER_FILE, RETAINED_BACKEND_FILE, ISOLATION_CLEANUP_FILE];
	for (const entry of await fs.readdir(dir)) {
		if (markers.includes(entry)) continue;
		await fs.rm(path.join(dir, entry), { recursive: true, force: true });
	}
	for (const marker of markers) {
		await fs.rm(path.join(dir, marker), { force: true });
	}
	await fs.rmdir(dir);
}

/**
 * After a teardown failure the record may have moved into trash with the
 * wrapper. Find it, clear the dead claim, and leave a retryable authorized
 * state in place; the next pass re-validates everything.
 */
async function restoreRetryableRecord(
	root: string,
	originalDir: string,
	record: IsolationCleanupRecord,
): Promise<void> {
	const candidates = [originalDir];
	const trashChild = path.join(root, ISOLATION_TRASH_DIR, `${path.basename(originalDir)}.${record.generation}`);
	if (trashChild !== originalDir) candidates.push(trashChild);
	for (const dir of candidates) {
		const current = await readIsolationCleanup(dir).catch(() => undefined);
		if (!current || current.generation !== record.generation) continue;
		const { claim: _claim, ...retryable } = current;
		await writeIsolationCleanup(dir, retryable as IsolationCleanupRecord).catch(() => undefined);
		return;
	}
}

function isLockContention(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Failed to acquire lock");
}

/** Metadata lock over the worktree root; `options` forwards to the file lock (e.g. `{ retries: 1 }` for background skips). */
export function withIsolationMetadataLock<T>(
	root: string,
	fn: () => Promise<T>,
	options?: { retries?: number },
): Promise<T> {
	return withFileLock(path.join(root, ISOLATION_GC_LOCK_STEM), fn, options);
}

/** The managed isolation wrapper containing `dir`, when `dir` lives inside one. */
export function managedSourceWrapper(root: string, dir: string): string | undefined {
	const relative = path.relative(path.resolve(root), path.resolve(dir));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const parts = relative.split(path.sep);
	if (parts[0] === ISOLATION_TRASH_DIR) {
		return parts.length >= 2 ? path.join(root, parts[0], parts[1]) : undefined;
	}
	return ISOLATION_SEGMENT_PATTERN.test(parts[0]) ? path.join(root, parts[0]) : undefined;
}

interface SlotParams {
	id: string;
	generation: string;
	backend: number;
	sourceBaseDir: string | undefined;
}

/**
 * Prepare a deterministic isolation slot for a new generation: validate that
 * any occupant is a positively-authorized dead generation, then register the
 * new generation's cleanup record and owner marker under the root lock.
 * Returns a previously-authorized wrapper to remove (outside the lock), or
 * `undefined` when the slot was free. Throws naming the occupant when the
 * slot is occupied by a live, unknown, or retained generation.
 */
export async function claimSlotForNewGeneration(
	root: string,
	baseDir: string,
	params: SlotParams,
): Promise<IsolationCleanupRecord | undefined> {
	return withIsolationMetadataLock(root, async () => {
		const existing = await readIsolationCleanup(baseDir).catch(() => undefined);
		if (existing) {
			const stale = await findReclaimableOccupant(root, baseDir, existing);
			if (stale) return stale;
			const owner = await readIsolationOwner(baseDir).catch(() => undefined);
			throw new Error(
				`isolation slot ${baseDir} is occupied by ${existing.state} generation ${existing.generation}` +
					(owner ? ` owned by pid ${owner.pid}` : " with an unreadable owner marker") +
					`; inspect it with \`omp worktree list\` and clear it before respawning this task id`,
			);
		}
		// Record-less legacy shell: marker-only pending wrappers and empty slots
		// hold no agent work; a payload-bearing legacy clone is never auto-wiped
		// by the GC, but a re-spawn of its task id may reclaim it explicitly —
		// persist the authorization so removeAuthorizedWrapper can act on it.
		if ((await findMergedDir(baseDir)) !== undefined) {
			const owner = await readIsolationOwner(baseDir).catch(() => undefined);
			if (owner && (await isIsolationOwnerLive(owner))) {
				throw new Error(
					`isolation slot ${baseDir} is occupied by a live legacy sandbox owned by pid ${owner.pid}` +
						`; the owning process must stop it first (or use \`omp worktree clear --all\`)` +
						` before respawning this task id`,
				);
			}
			const stale: IsolationCleanupRecord = {
				version: 1,
				generation: "legacy",
				backend: params.backend,
				detached: false,
				disposition: "preserve",
				state: "ready",
				authorization: { kind: "explicit" },
			};
			await writeIsolationCleanup(baseDir, stale);
			return stale;
		}
		await registerIsolationGenerationUnlocked(baseDir, params);
		return undefined;
	});
}

/** The two registration writes, caller holds the root metadata lock. */
async function registerIsolationGenerationUnlocked(baseDir: string, params: SlotParams): Promise<void> {
	await writeIsolationCleanup(baseDir, {
		version: 1,
		generation: params.generation,
		backend: params.backend,
		detached: false,
		disposition: "preserve",
		...(params.sourceBaseDir ? { sourceBaseDir: params.sourceBaseDir } : {}),
		state: "active",
	});
	await writeIsolationOwner(baseDir, params.id);
}

/**
 * Register a new generation in a slot whose occupant (if any) was already
 * removed: the cleanup record and owner marker MUST be on disk before
 * `isoStart` materializes the mount, or a concurrent `omp worktree clear`
 * sees a live sandbox with no verifiable owner.
 */
export async function registerIsolationGeneration(root: string, baseDir: string, params: SlotParams): Promise<void> {
	await withIsolationMetadataLock(root, async () => {
		const existing = await readIsolationCleanup(baseDir).catch(() => undefined);
		if (existing) {
			throw new Error(
				`isolation slot ${baseDir} is occupied by ${existing.state} generation ${existing.generation}` +
					`; inspect it with \`omp worktree list\` and clear it before respawning this task id`,
			);
		}
		await registerIsolationGenerationUnlocked(baseDir, params);
	});
}

/** An authorized dead occupant a new generation may reclaim, if any. */
async function findReclaimableOccupant(
	root: string,
	baseDir: string,
	existing: IsolationCleanupRecord,
): Promise<IsolationCleanupRecord | undefined> {
	if (!existing.authorization) return undefined;
	if (existing.state !== "ready" && existing.state !== "deleting" && existing.state !== "trash") return undefined;
	if (existing.claim && (await isIsolationOwnerLive(existing.claim))) return undefined;
	const owner = await readIsolationOwner(baseDir).catch(() => undefined);
	// A trash relocation may have already removed the owner marker; the
	// authorization was validated when the entry was marked ready.
	if (owner && (await isIsolationOwnerLive(owner))) return undefined;
	if (!owner && !inTrash(root, baseDir) && existing.state === "ready") {
		// Owner marker missing at the original path is unknown ownership
		// unless evidence was already verified for this generation.
		if (existing.authorization.kind === "snapshot") {
			if (!(await verifyIsolationRecoveryArtifacts(existing.authorization.artifacts))) return undefined;
		}
	}
	return existing;
}


/** Flip the record to `detached: true` after `detachGitDir` succeeds. */
export async function markIsolationDetached(root: string, baseDir: string): Promise<void> {
	await withIsolationMetadataLock(root, async () => {
		const record = await readIsolationCleanup(baseDir).catch(() => undefined);
		if (!record || record.detached) return;
		await writeIsolationCleanup(baseDir, { ...record, detached: true });
	});
}

/**
 * Remove a wrapper whose generation never ran an agent (setup failure or
 * fallback retry): explicitly authorized, safe to tear down immediately.
 */
export async function discardIncompleteWrapper(root: string, baseDir: string): Promise<void> {
	await withIsolationMetadataLock(root, async () => {
		const record = await readIsolationCleanup(baseDir).catch(() => undefined);
		if (record) {
			await writeIsolationCleanup(baseDir, { ...record, state: "ready", authorization: { kind: "explicit" } });
		}
	});
	await removeAuthorizedWrapper(root, baseDir);
}

/**
 * Physically remove a wrapper already carrying valid release authorization.
 * Claims the entry under the root lock, tears it down at the backend-appropriate
 * path, and leaves resumable metadata on failure.
 */
export async function removeAuthorizedWrapper(root: string, dir: string): Promise<void> {
	const record = await readIsolationCleanup(dir).catch(() => undefined);
	if (!record || !record.authorization) return;
	const claimed = await claimForTeardown(root, dir, record.generation);
	if (!claimed) return;
	await teardownClaimedWrapper(root, dir, claimed);
}
