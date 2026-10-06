/**
 * Storage-only relocation of a live session tree: when a root session's
 * transcript moves (contested-write recovery minting a sibling, or an explicit
 * `/move`), every registry ref whose transcript lives under the old root's
 * artifact tree belongs to the SAME continuing tree and must follow it. The
 * exact ref objects are repointed in place — never unregistered/re-registered —
 * so adoption ownership, idle timers, retained-clone release closures, and
 * in-flight CAS expectations survive. Live children are rebased through their
 * own SessionManager (writer drain + atomic republish of the current journal);
 * parked refs are repointed only after the seed proves the bytes exist at the
 * new root.
 *
 * Migrations of one continuing owner are SERIALIZED: an A→B→C chain never lets
 * the B→C migration scan descendants before the A→B migration finished
 * rebasing them, so a live child mid-rebase cannot be skipped and stranded.
 * A migration REJECTS when the seed or any child rebase failed; roster scans
 * of the destination root join that barrier and fail closed (in-memory peers)
 * rather than replacing still-owned refs with stale seeded copies.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { SessionFileChange } from "../session/session-manager";
import type { AgentRef, AgentRegistry } from "./agent-registry";
import { registerRootMigrationBarrier, sessionFileBelongsToRoot } from "./persisted-agents";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;

/**
 * Serialized migration tails, keyed by registry and the exact owning ref
 * OBJECT: a recovery chain (A→B→C) shares one ref, while a replaced root
 * generation (a stale manager's late event) carries a different ref and must
 * neither CAS-update nor serialize against the live owner's migrations.
 */
const migrationTails = new WeakMap<AgentRegistry, Map<AgentRef, Promise<void>>>();

function rebasePathUnderRoot(file: string, oldArtifactRoot: string, newArtifactRoot: string): string {
	const relative = path.relative(oldArtifactRoot, path.resolve(file));
	return path.join(newArtifactRoot, relative);
}

/**
 * Translate one persisted artifact path to the new root — only when the file
 * verifiably exists there (seeded or republished). Returns undefined when the
 * path lives outside the moved tree; returns the ORIGINAL path when the
 * translated target is absent, so history never points at bytes that never
 * landed.
 */
async function rebaseArtifactPath(
	artifactPath: string | undefined,
	oldArtifactRoot: string,
	newArtifactRoot: string,
): Promise<string | undefined> {
	if (!artifactPath) return artifactPath;
	const resolved = path.resolve(artifactPath);
	if (!resolved.startsWith(`${oldArtifactRoot}${path.sep}`)) return artifactPath;
	const rebased = path.join(newArtifactRoot, path.relative(oldArtifactRoot, resolved));
	const exists = await fs
		.access(rebased)
		.then(() => true)
		.catch(() => false);
	return exists ? rebased : artifactPath;
}

/**
 * React to this session's own storage-only relocation: repoint its registry
 * ref immediately (the ref is how peers/rosters find the transcript), then —
 * for the root session only — migrate the whole descendant tree against the
 * seed's readiness, serialized behind this owner's prior migration, and gate
 * roster scans of the new root on the outcome. The change fires synchronously
 * inside the manager's disk queue, so the migration body is scheduled, never
 * awaited here.
 */
export function handleSessionFileChange(
	registry: AgentRegistry,
	ownId: string,
	ownRef: AgentRef,
	change: SessionFileChange,
	options?: { root?: boolean },
): void {
	// Exact-owner CAS: a stale event from a replaced root generation neither
	// repoints the live ref nor queues a migration against another owner's
	// descendants.
	if (!registry.setSessionFile(ownId, change.to, ownRef)) return;
	if (options?.root !== true) return;
	let tails = migrationTails.get(registry);
	if (!tails) {
		tails = new Map();
		migrationTails.set(registry, tails);
	}
	// Chain behind this exact owner's previous migration. A prior failure
	// never blocks the next relocation's migration; each link reports its own.
	const prior = tails.get(ownRef) ?? Promise.resolve();
	const migration = prior.catch(() => undefined).then(() => migrateSessionTreeRefs(registry, change));
	// Handled here so an unwatched failure is not an unhandled rejection; the
	// roster barrier observes the rejection through the same promise.
	void migration.catch(() => undefined);
	tails.set(ownRef, migration);
	const drop = () => {
		if (tails.get(ownRef) === migration) tails.delete(ownRef);
	};
	migration.then(drop, drop);
	registerRootMigrationBarrier(change.to, migration);
}

async function migrateSessionTreeRefs(registry: AgentRegistry, change: SessionFileChange): Promise<void> {
	if (!change.from.endsWith(".jsonl") || !change.to.endsWith(".jsonl")) return;
	const oldArtifactRoot = path.resolve(change.from.slice(0, -JSONL_SUFFIX_LENGTH));
	const newArtifactRoot = path.resolve(change.to.slice(0, -JSONL_SUFFIX_LENGTH));
	const errors: Error[] = [];
	// Live children must rebase even when the seed failed — their writers
	// cannot keep appending into the now-foreign old root — but parked refs
	// and history paths only move once the bytes provably exist at the new
	// root (a failed copy leaves the old transcripts readable where they are).
	const seeded = await change.ready.then(
		() => true,
		error => {
			errors.push(toError(error));
			logger.warn("Session tree artifact seed failed; parked refs keep their old paths", {
				from: change.from,
				to: change.to,
				error: toError(error).message,
			});
			return false;
		},
	);
	for (const ref of registry.list()) {
		const sessionFile = ref.sessionFile;
		if (!sessionFile || sessionFile === change.from) continue;
		if (!sessionFileBelongsToRoot(sessionFile, change.from)) continue;
		const rebased = rebasePathUnderRoot(sessionFile, oldArtifactRoot, newArtifactRoot);
		if (ref.session) {
			try {
				await ref.session.sessionManager.rebaseSessionFile(rebased, change.reason);
			} catch (error) {
				// Fail closed: the ref keeps its current path (the child's writer
				// was drained before the error) rather than pointing at a file
				// the child never published. The migration rejects below so the
				// roster barrier refuses to certify this root.
				errors.push(toError(error));
				logger.warn("Live child session rebase failed", {
					id: ref.id,
					from: sessionFile,
					to: rebased,
					error: toError(error).message,
				});
				continue;
			}
			// The rebase awaited: the adoption may have been replaced or released
			// in between. Never restamp a generation this migration did not
			// start from.
			if (registry.get(ref.id) !== ref) continue;
			// The child's own change event already repointed its ref; this is a
			// CAS-guarded no-op then, and the actual update when it is not.
			registry.setSessionFile(ref.id, rebased, ref);
		} else if (seeded) {
			// Repoint only when the transcript provably exists at the new root;
			// a seeded-prefix copy that never landed must not strand the ref.
			const transcriptExists = await fs
				.access(rebased)
				.then(() => true)
				.catch(() => false);
			if (!transcriptExists || registry.get(ref.id) !== ref) continue;
			if (!registry.setSessionFile(ref.id, rebased, ref)) continue;
			const history = ref.history;
			if (!history) continue;
			const delta: { outputPath?: string; patchPath?: string; nestedPatchPaths?: string[] } = {};
			const outputPath = await rebaseArtifactPath(history.outputPath, oldArtifactRoot, newArtifactRoot);
			if (outputPath !== undefined && outputPath !== history.outputPath) delta.outputPath = outputPath;
			const patchPath = await rebaseArtifactPath(history.patchPath, oldArtifactRoot, newArtifactRoot);
			if (patchPath !== undefined && patchPath !== history.patchPath) delta.patchPath = patchPath;
			if (history.nestedPatchPaths) {
				const nestedPatchPaths: string[] = [];
				for (const patch of history.nestedPatchPaths) {
					nestedPatchPaths.push((await rebaseArtifactPath(patch, oldArtifactRoot, newArtifactRoot)) ?? patch);
				}
				if (nestedPatchPaths.some((patch, index) => patch !== history.nestedPatchPaths?.[index])) {
					delta.nestedPatchPaths = nestedPatchPaths;
				}
			}
			if (Object.keys(delta).length > 0) registry.setHistory(ref.id, delta, rebased);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, `Session tree migration to ${change.to} failed for ${errors.length} item(s).`);
	}
}
