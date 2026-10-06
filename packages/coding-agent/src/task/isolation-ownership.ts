/**
 * Ownership marker for task-isolation sandboxes under `~/.omp/wt/`.
 *
 * Each isolation base dir (`ensureIsolation` in {@link ./worktree}) holds a
 * compact `m` mount plus this marker file naming the omp process that created
 * it. `omp worktree clear` consults the marker so it can distinguish a live
 * subagent's sandbox from a crashed run's leftover instead of deleting both.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { replaceFileAtomically } from "../utils/atomic-file";

const { IsoBackendKind } = natives;

/** Marker file written into a task-isolation base dir identifying its owner. */
export const ISOLATION_OWNER_FILE = ".omp-isolation-owner.json";

/**
 * Recognizable task-isolation wrapper segment: the deterministic `t<9 hex>`
 * slot from `getTaskIsolationSegment`, optionally suffixed by
 * `retainIsolationWorkspace`'s unique `.retained-<ts>-<rand>` relocation.
 */
export const ISOLATION_SEGMENT_PATTERN = /^t[0-9a-f]{9}(?:\.retained-[0-9a-z]+-[0-9a-f]+)?$/;

/** Recorded owner of a task-isolation sandbox. */
export interface IsolationOwner {
	/** PID of the omp process that created and owns the sandbox. */
	pid: number;
	/** Task id the sandbox was materialised for. */
	id: string;
	/**
	 * Process-instance start-time token for {@link pid}, when the OS can report
	 * it. Distinguishes the owning process from an unrelated process that later
	 * inherits a recycled pid, so a crashed sandbox is never pinned live.
	 */
	startToken?: string;
}

/**
 * Boot-stable start-time token for `pid`, or `null` when the process is gone or
 * the platform cannot report it. Read from the same source on write and
 * validate so an exact string compare rejects a recycled pid.
 *
 * Linux reads `/proc/<pid>/stat` field 22 (start time in clock ticks since
 * boot); other Unixes shell out to `ps -o lstart`. Platforms that report
 * neither (e.g. Windows) yield `null`, degrading to a pid-only liveness check.
 */
async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}
		// The comm field (2) may embed spaces and parens, so parse the numeric
		// fields after the final ')'. `starttime` is field 22 overall, i.e. the
		// 20th token once `pid` and `(comm)` are dropped.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}
/**
 * Build a collector claim identity for the current process — the same
 * pid/start-token shape as an owner marker, but naming the cleanup
 * continuation rather than the creating agent.
 */
export async function currentIsolationClaim(): Promise<{ pid: number; startToken?: string }> {
	const startToken = await processStartToken(process.pid);
	return { pid: process.pid, ...(startToken ? { startToken } : {}) };
}

/**
 * Build an owner record for the current process. Exported so cleanup metadata
 * can stamp the same identity shape as the owner marker.
 */
export async function currentIsolationOwner(id: string): Promise<IsolationOwner> {
	const startToken = await processStartToken(process.pid);
	return { pid: process.pid, id, ...(startToken ? { startToken } : {}) };
}

/**
 * Record `owner` as the owner of the sandbox rooted at `baseDir`. Callers
 * pass a prepared current-process identity (see `currentIsolationOwner`) so
 * the slow start-token probe happens before, not under, the root metadata
 * lock.
 *
 * Written before the isolation backend materialises `m` so a concurrent
 * `omp worktree clear` never sees an owner-less sandbox mid-creation.
 */
export async function writeIsolationOwner(baseDir: string, owner: IsolationOwner): Promise<void> {
	await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify(owner));
}

/** Read and validate the owner marker. `undefined` only when the file is absent. */
export async function readIsolationOwner(baseDir: string): Promise<IsolationOwner | undefined> {
	const marker = path.join(baseDir, ISOLATION_OWNER_FILE);
	let decoded: unknown;
	try {
		decoded = await Bun.file(marker).json();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	const parsed = parseIsolationOwner(decoded);
	if (!parsed) throw new Error(`isolation owner marker at ${marker} is malformed`);
	return parsed;
}

/** Validate decoded JSON as an owner record; `undefined` when the shape is wrong. */
function parseIsolationOwner(decoded: unknown): IsolationOwner | undefined {
	if (typeof decoded !== "object" || decoded === null || !("pid" in decoded)) return undefined;
	const { pid, id, startToken } = decoded as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (typeof id !== "string" || id.length === 0) return undefined;
	if (startToken !== undefined && (typeof startToken !== "string" || startToken.length === 0)) return undefined;
	return { pid, id, ...(startToken !== undefined ? { startToken } : {}) };
}

/**
 * Whether the process described by an owner/claim identity is still alive.
 *
 * `process.kill(pid, 0)` can fail with `EPERM` even when the process is alive,
 * so only an explicit `ESRCH` ("no such process") counts as dead; any other
 * error is treated as alive to avoid deleting a sandbox that is actually in
 * use. When the identity carries a start-time token, a live pid whose current
 * token no longer matches is a recycled pid — a different process — and counts
 * as dead.
 *
 * `currentProcessToken` is an optional snapshot of THIS process's start token
 * captured by the caller before waiting on a lock (`null` when the platform
 * could not report it). It substitutes the fresh token read only when the
 * identity names this still-running process; foreign pids always re-probe.
 * A `null` snapshot stays conservative: the identity counts as live.
 */
export async function isIsolationOwnerLive(
	owner: Pick<IsolationOwner, "pid" | "startToken">,
	currentProcessToken?: string | null,
): Promise<boolean> {
	try {
		process.kill(owner.pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	// The pid is live (or unknowable via EPERM). Reject a recycled pid: if the
	// identity pinned the owner's start-time token, the process wearing that
	// pid now must still present the same token.
	if (owner.startToken !== undefined && owner.startToken.length > 0) {
		const current =
			owner.pid === process.pid && currentProcessToken !== undefined
				? currentProcessToken
				: await processStartToken(owner.pid);
		if (current !== null && current !== owner.startToken) return false;
	}
	return true;
}

/**
 * Whether a live omp process still owns the sandbox at `baseDir`.
 *
 * A missing or malformed marker means no verifiable owner — a crashed run or a
 * sandbox from before markers existed, both safe to reclaim by the manual
 * `clear` path. Automatic GC uses {@link readIsolationOwner} instead: there,
 * unknown ownership must fail closed rather than count as proven death.
 */
export async function hasLiveIsolationOwner(baseDir: string): Promise<boolean> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).json();
	} catch {
		return false;
	}
	const parsed = parseIsolationOwner(decoded);
	if (!parsed) return false;
	return isIsolationOwnerLive(parsed);
}

/** Sidecar recording the native-teardown backend of a retained workspace. */
export const RETAINED_BACKEND_FILE = ".omp-retained-backend.json";

/**
 * Backends whose workspaces `omp worktree clear` must not remove with plain
 * recursive `rm`, but route through native `isoStop` teardown instead:
 * mounts (overlayfs, projfs), where `rm` destroys the preserved layer and
 * fails on the mountpoint, and Btrfs subvolumes, whose root is only removable
 * via subvolume delete (its `stop` falls back to plain `rm` for ordinary
 * dirs, so routing it is always safe). Plain-copy and reflink backends need
 * no teardown — and their `stop` routines delete data themselves, so they
 * must never be routed through it.
 *
 * Notably absent: ZFS clones also need dataset-aware teardown, but `isoStop`
 * locates the dataset by its recorded mountpoint property, which no longer
 * matches after the retain rename — that needs pi-iso mount-table support
 * before a sidecar here could help.
 */
export function needsNativeTeardown(backend: unknown): backend is number {
	return backend === IsoBackendKind.Overlayfs || backend === IsoBackendKind.Projfs || backend === IsoBackendKind.Btrfs;
}

/**
 * Record which backend built a retained workspace, so cleanup can route it
 * through native teardown before removal. Best-effort: retention stays valid
 * without it (the workspace merely falls back to plain recursive removal).
 */
export async function writeRetainedBackend(baseDir: string, backend: number): Promise<void> {
	await Bun.write(
		path.join(baseDir, RETAINED_BACKEND_FILE),
		JSON.stringify({ backend, retainedAt: new Date().toISOString() }),
	);
}

/**
 * Backend recorded for a retained workspace when it needs native teardown
 * before remove. `undefined` only when no sidecar exists. Any other read
 * problem (permissions, I/O, malformed JSON) throws instead of reading as
 * absent: the workspace may be a live mount whose guard must not be silently
 * bypassed — the caller then leaves it in place rather than removing through
 * the mount. A well-formed record for a backend needing no teardown keeps
 * today's removal behavior.
 */
export async function readRetainedMountBackend(dir: string): Promise<number | undefined> {
	const sidecar = path.join(dir, RETAINED_BACKEND_FILE);
	if (!(await Bun.file(sidecar).exists())) return undefined;
	const decoded: unknown = await Bun.file(sidecar).json();
	if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	const backend = decoded.backend;
	if (typeof backend !== "number" || !Number.isInteger(backend)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	if (!needsNativeTeardown(backend)) return undefined;
	return backend;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup record — durable authorization for automatic reclamation.
//
// The owner marker answers "who owns this sandbox". The cleanup record answers
// "may an automatic collector remove it": it names the backend that must tear
// the workspace down, records the clone-generation it belongs to, and — for
// mutable work — the exact patch files that carry the saved changes. A dead
// owner alone never authorizes deletion; only a validated record does.
// ═══════════════════════════════════════════════════════════════════════════

/** Sidecar recording the cleanup/authorization contract for one generation. */
export const ISOLATION_CLEANUP_FILE = ".omp-isolation-cleanup.json";

/** One recovered patch file a collector must find intact before deletion. */
export interface IsolationRecoveryArtifact {
	/** Absolute path of the published artifact. */
	path: string;
	/** SHA-256 hex digest of the artifact bytes at publication time. */
	sha256: string;
}

/**
 * Why a workspace may be reclaimed:
 * - `snapshot` — a complete final patch set was published and verified.
 * - `discard` — the clone ran with a discard disposition; nothing to save.
 * - `explicit` — a caller that never runs an agent (setup failure, security
 *   remediation) requested teardown directly.
 */
export type IsolationCleanupAuthorization =
	| { kind: "snapshot"; artifacts: IsolationRecoveryArtifact[] }
	| { kind: "discard" }
	| { kind: "explicit" };

/**
 * Generations are UUIDv4 or short test labels; the strict charset keeps the
 * value path-safe wherever it is interpolated into filesystem names. `..` is
 * excluded by the charset (no repeated-dot runs) and the length caps abuse.
 */
const ISOLATION_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
type IsolationCleanupState = "active" | "finalizing" | "ready" | "retained" | "deleting" | "trash";

const ISOLATION_CLEANUP_STATES: readonly IsolationCleanupState[] = [
	"active",
	"finalizing",
	"ready",
	"retained",
	"deleting",
	"trash",
];

const ISO_BACKEND_KIND_VALUES = new Set(Object.values(natives.IsoBackendKind));

/**
 * Lifecycle/authorization record for one isolation generation, stored at
 * `.omp-isolation-cleanup.json`. `state` tracks physical progress:
 * `active` (agent may still run) → `finalizing` (writer fence + final
 * snapshot) → `ready` (complete snapshot verified) → `deleting`/`trash`
 * (collector claimed it) — or `retained`, an intentional recovery holdout.
 * `authorization` explains why `ready` is safe to delete.
 */
export interface IsolationCleanupRecord {
	version: 1;
	/** Identity of this materialization; a re-created slot is a new generation. */
	generation: string;
	/** Backend that actually materialized `m` (recorded per candidate attempt). */
	backend: number;
	/** True once the clone's git metadata was successfully detached. */
	detached: boolean;
	/** Whether the generation ran with a discard disposition. */
	disposition: "preserve" | "discard";
	/** Canonical managed wrapper holding the source checkout, when known. */
	sourceBaseDir?: string;
	state: IsolationCleanupState;
	authorization?: IsolationCleanupAuthorization;
	/** Collector identity currently performing physical teardown. */
	claim?: { pid: number; startToken?: string };
}

/** Validate decoded JSON as a cleanup record; `undefined` when the shape is wrong. */
function parseIsolationCleanupRecord(decoded: unknown): IsolationCleanupRecord | undefined {
	if (typeof decoded !== "object" || decoded === null) return undefined;
	const record = decoded as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	// Path-safe format: the generation is interpolated into trash rename
	// targets, so separators and traversal segments must never reach disk.
	if (typeof record.generation !== "string" || !ISOLATION_GENERATION_PATTERN.test(record.generation)) return undefined;
	if (typeof record.backend !== "number" || !ISO_BACKEND_KIND_VALUES.has(record.backend)) return undefined;
	if (typeof record.detached !== "boolean") return undefined;
	if (record.disposition !== "preserve" && record.disposition !== "discard") return undefined;
	if (typeof record.state !== "string" || !ISOLATION_CLEANUP_STATES.includes(record.state as IsolationCleanupState))
		return undefined;
	if (
		record.sourceBaseDir !== undefined &&
		(typeof record.sourceBaseDir !== "string" || record.sourceBaseDir.length === 0)
	)
		return undefined;
	const authorization = record.authorization;
	if (authorization !== undefined) {
		if (typeof authorization !== "object" || authorization === null) return undefined;
		const kind = (authorization as Record<string, unknown>).kind;
		if (kind === "snapshot") {
			const artifacts = (authorization as Record<string, unknown>).artifacts;
			if (!Array.isArray(artifacts)) return undefined;
			for (const artifact of artifacts) {
				if (typeof artifact !== "object" || artifact === null) return undefined;
				const entry = artifact as Record<string, unknown>;
				if (typeof entry.path !== "string" || entry.path.length === 0) return undefined;
				if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return undefined;
			}
		} else if (kind !== "discard" && kind !== "explicit") {
			return undefined;
		}
	}
	const claim = record.claim;
	if (claim !== undefined) {
		if (typeof claim !== "object" || claim === null) return undefined;
		const claimPid = (claim as Record<string, unknown>).pid;
		if (typeof claimPid !== "number" || !Number.isInteger(claimPid) || claimPid <= 0) return undefined;
		const claimToken = (claim as Record<string, unknown>).startToken;
		if (claimToken !== undefined && (typeof claimToken !== "string" || claimToken.length === 0)) return undefined;
	}
	return record as unknown as IsolationCleanupRecord;
}

/**
 * Read and validate the cleanup record. `undefined` only when the file is
 * absent — a missing record means the sandbox predates the contract or died
 * mid-creation, both unknown rather than reclaimable. Malformed or unreadable
 * records throw so callers fail closed instead of deleting through ambiguity.
 */
export async function readIsolationCleanup(baseDir: string): Promise<IsolationCleanupRecord | undefined> {
	const sidecar = path.join(baseDir, ISOLATION_CLEANUP_FILE);
	let decoded: unknown;
	try {
		decoded = await Bun.file(sidecar).json();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	const parsed = parseIsolationCleanupRecord(decoded);
	if (!parsed) throw new Error(`isolation cleanup record at ${sidecar} is malformed`);
	return parsed;
}

/**
 * Atomically publish a cleanup record. Callers validate the record and hold
 * the worktree-root metadata lock across generation/authorization/claim
 * transitions; the write itself is a staged sibling file replaced atomically
 * so a crash never leaves a torn record.
 */
export async function writeIsolationCleanup(baseDir: string, record: IsolationCleanupRecord): Promise<void> {
	const target = path.join(baseDir, ISOLATION_CLEANUP_FILE);
	if (parseIsolationCleanupRecord(record) === undefined) {
		throw new Error(`refusing to publish malformed isolation cleanup record for ${record?.generation ?? "?"}`);
	}
	const staged = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(staged, JSON.stringify(record));
		await replaceFileAtomically(staged, target);
	} catch (error) {
		await fs.rm(staged, { force: true }).catch(() => undefined);
		throw error;
	}
}
