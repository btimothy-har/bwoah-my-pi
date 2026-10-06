/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { OutputArtifactLease } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { replaceFileAtomically } from "../utils/atomic-file";

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory. Collapse everything
 * outside `[A-Za-z0-9_-]` to `_`, and cap the length so an arbitrarily long
 * name cannot overflow the filesystem's filename limit (ENAMETOOLONG). Fall
 * back to `tool` when nothing survives.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

/**
 * Persist an artifact only when the filesystem confirms the complete payload is
 * readable, then swap it into place atomically.
 *
 * Content is staged to a temporary sibling and verified (byte count, on-disk
 * size, readability) before an atomic `rename` publishes it. `agent://<id>`
 * discovers `${id}.md` by scanning the artifacts directory rather than reading
 * `result.outputPath`, so a direct in-place write that fell short would leave
 * a truncated file resolvable as incomplete output and a failed follow-up write
 * would destroy the prior valid artifact. Staging keeps both hazards out: on
 * any failure the temp file is removed and the existing artifact at `path` is
 * untouched.
 *
 * Returns the verified UTF-8 byte count.
 */
export async function writeArtifact(path: string, content: string): Promise<number> {
	const expectedBytes = Buffer.byteLength(content);
	const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
	try {
		const writtenBytes = await Bun.write(tempPath, content);
		if (writtenBytes !== expectedBytes) {
			throw new Error(`Artifact write incomplete: wrote ${writtenBytes} of ${expectedBytes} bytes`);
		}
		const file = Bun.file(tempPath);
		if (file.size !== expectedBytes) {
			throw new Error(`Artifact size mismatch: found ${file.size} of ${expectedBytes} bytes`);
		}
		await file.slice(0, Math.min(expectedBytes, 1)).arrayBuffer();
		await replaceFileAtomically(tempPath, path);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
	return expectedBytes;
}

/** SDK artifact reservation; managed writers settle their lease after closing. */
export interface ArtifactAllocation {
	id?: string;
	path?: string;
	lease?: OutputArtifactLease;
}

export interface ManagedArtifactAllocation extends ArtifactAllocation {
	id: string;
	path: string;
	lease: OutputArtifactLease;
}

/** Per-allocation bookkeeping for leases issued by an {@link ArtifactManager}. */
interface AllocationState {
	/** Reserved numeric id (monotonic per manager; never reused). */
	id: string;
	/** Final filename (`<id>.<tool>.log`); invariant across relocations. */
	filename: string;
	/** Where bytes are actually being written, pinned on first resolve/write. */
	openPath: string | undefined;
	/** Memoized settlement; shared by every complete() caller. */
	completion: Promise<void> | undefined;
}

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 *
 * Subagents do not own their own `ArtifactManager`. The parent's instance is
 * adopted via `SessionManager.adoptArtifactManager`, so the whole parent +
 * subagent tree shares one ID space and one directory.
 *
 * The manager object is STABLE across storage-only relocations of its owning
 * session (contested-write recovery, `/move`): `rebind` retargets the
 * directory and chains the relocation's seed onto the readiness tail instead
 * of replacing the manager. Issued IDs are monotonic for the object's
 * lifetime — a rebind or an interrupted first-use scan never lowers the
 * high-water mark, so a recovered parent and its adopted children never hand
 * out colliding IDs.
 */
export class ArtifactManager {
	#nextId = 0;
	#dir: string;
	#dirCreated = false;
	#initPromise: Promise<void> | null = null;
	/**
	 * Chained relocation readiness: constructor seed plus every later rebind's
	 * seed, in order. REJECTS when the latest link's seed failed — allocations
	 * and lookups must not proceed on, or advertise, an unseeded root. A
	 * rejection handler is attached internally so an unwatched tail never
	 * reports an unhandled rejection; observers of {@link whenReady} still see
	 * the rejection. A failed link never blocks the NEXT rebind's seed.
	 */
	#readyTail: Promise<void>;
	/** Bumped per rebind so in-flight allocation settlement can detect a move. */
	#generation = 0;
	/** Outstanding (unsettled) allocations by id, for relocation-aware lookup. */
	#allocations = new Map<string, AllocationState>();

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 * @param ready Settles once `dir` is seeded (a session move copying the previous
	 *   session's artifacts in the background). Id scans and lookups wait for it,
	 *   so new ids never collide with copied ones. Rejects when the seed failed:
	 *   consumers fail closed rather than scanning an unseeded root.
	 */
	constructor(dir: string, ready?: Promise<void>) {
		this.#dir = dir;
		const tail = ready ?? Promise.resolve();
		// Attach handling so an unwatched seed failure is never an unhandled
		// rejection; whenReady() still rejects truthfully for every observer.
		void tail.catch(() => undefined);
		this.#readyTail = tail;
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	/** Settles once every relocation seed queued so far has finished. Never rejects. */
	whenReady(): Promise<void> {
		return this.#readyTail;
	}

	/**
	 * Retarget this manager at `dir` once `ready` (the relocation seed that
	 * populates it) settles. Synchronous: the next allocation or lookup already
	 * sees the new directory and waits on the full chained tail, so no consumer
	 * can scan or allocate into the new root before its seed completed. The
	 * first-use scan re-runs lazily against the new directory; an old scan that
	 * was in flight across the rebind may only RAISE the id high-water mark,
	 * never lower it.
	 *
	 * `options.carried` MUST be set only when the artifact tree was relocated by
	 * a verified whole-directory rename: open file descriptors follow the inode,
	 * so an outstanding allocation's pinned open path is translated to the new
	 * directory and its bytes are already there. A copy-based recovery seed
	 * (`carried` unset) leaves pinned paths at the old root; settlement then
	 * publishes the finalized bytes into the new root instead.
	 */
	rebind(dir: string, ready: Promise<void>, options?: { carried?: boolean }): void {
		this.#generation++;
		const previousDir = this.#dir;
		this.#dir = dir;
		this.#dirCreated = false;
		this.#initPromise = null;
		if (options?.carried === true && path.resolve(previousDir) !== path.resolve(dir)) {
			// Exact-owner retargeting, not a global alias: only allocations this
			// manager issued and pinned under the previous root follow it.
			for (const state of this.#allocations.values()) {
				if (state.openPath && path.resolve(state.openPath).startsWith(`${path.resolve(previousDir)}${path.sep}`)) {
					state.openPath = path.join(dir, state.filename);
				}
			}
		}
		// Chain behind the prior tail without inheriting its failure: each
		// link's outcome is its own seed's. The new link rejects when THIS seed
		// fails, so allocations/lookups against this root fail closed; the
		// attached handler only suppresses unhandled-rejection noise.
		const next = this.#readyTail.catch(() => undefined).then(() => ready);
		void next.catch(() => undefined);
		this.#readyTail = next;
	}

	async #ensureDir(): Promise<void> {
		await this.whenReady();
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		// Memoize the first-use scan so it runs exactly once. Concurrent callers
		// share the in-flight promise instead of each re-seeding #nextId across
		// the readdir yield in #scanExistingIds (which would hand duplicate ids).
		this.#initPromise ??= this.#scanExistingIds();
		await this.#initPromise;
	}

	/**
	 * Scan existing artifact files to raise the next-ID high-water mark.
	 * Monotonic: a scan that raced a rebind (or repeated scans across
	 * relocations) must never lower it, or an already-issued id could be
	 * handed out again.
	 */
	async #scanExistingIds(): Promise<void> {
		const files = await this.listFiles();
		let maxId = -1;
		for (const file of files) {
			// Files are named: {id}.{toolType}.log
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		if (maxId + 1 > this.#nextId) this.#nextId = maxId + 1;
	}

	/**
	 * Atomically allocate next artifact ID.
	 * IDs are sequential within the session.
	 */
	allocateId(): number {
		return this.#nextId++;
	}

	/**
	 * Allocate a new artifact path and ID without writing content.
	 *
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 */
	async allocatePath(toolType: string): Promise<ManagedArtifactAllocation> {
		return (await this.#allocate(toolType)).allocation;
	}

	async #allocate(toolType: string): Promise<{ state: AllocationState; allocation: ManagedArtifactAllocation }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		const state: AllocationState = { id, filename, openPath: undefined, completion: undefined };
		this.#allocations.set(id, state);
		const allocation: ManagedArtifactAllocation = {
			id,
			path: path.join(this.#dir, filename),
			lease: {
				resolvePath: () => this.#resolveAllocationPath(state),
				complete: () => this.#completeAllocation(state),
			},
		};
		return { state, allocation };
	}

	/**
	 * The path a writer should open for this allocation. Before settlement this
	 * awaits the relocation tail and pins the CURRENT root on first call (an
	 * unopened sink therefore never opens a vacated root); once pinned, the same
	 * open-write location is returned so a live writer keeps its descriptor.
	 * After {@link #completeAllocation} resolves, returns the finalized
	 * current-root path.
	 */
	async #resolveAllocationPath(state: AllocationState): Promise<string> {
		if (state.completion) {
			// A failed settlement rejects here too: callers must not advertise a
			// path whose bytes never landed in the current root.
			await state.completion;
			return path.join(this.#dir, state.filename);
		}
		if (state.openPath) return state.openPath;
		await this.whenReady();
		state.openPath = path.join(this.#dir, state.filename);
		return state.openPath;
	}

	/**
	 * Finalize this allocation's owned bytes into the current root, preserving
	 * the reserved id. Memoized: concurrent/duplicate callers share one
	 * settlement.
	 *
	 * Fail-closed: bytes the writer reported (the pinned open location) must
	 * exist and be readable, or the settlement rejects and the allocation is
	 * NOT advertised. A destination file is replaced only when it is a byte
	 * prefix of the finalized source — i.e. it is this allocation's own stale
	 * seed snapshot; unrelated data at the reserved name is never overwritten.
	 * Allocations that never opened a file settle without publishing anything.
	 */
	#completeAllocation(state: AllocationState): Promise<void> {
		state.completion ??= this.#settleAllocation(state);
		return state.completion;
	}

	async #settleAllocation(state: AllocationState): Promise<void> {
		let source = state.openPath;
		try {
			if (!source) return; // never opened: nothing was written, nothing to publish
			for (;;) {
				const generation = this.#generation;
				await this.whenReady();
				const target = path.join(this.#dir, state.filename);
				if (path.resolve(source) !== path.resolve(target)) {
					await fs.mkdir(this.#dir, { recursive: true });
					await moveOwnedArtifactFile(source, target);
					source = target;
				} else {
					const stat = await fs.stat(source).catch(() => null);
					if (!stat?.isFile()) {
						throw new Error(`Allocated artifact bytes are missing at ${source}`);
					}
				}
				if (this.#generation === generation) return;
				// A relocation landed while settling: follow it so the finalized
				// bytes reach the root that is current NOW.
			}
		} finally {
			// Settled (or failed terminally): lookups go back to directory scans.
			if (this.#allocations.get(state.id) === state) this.#allocations.delete(state.id);
		}
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 *
	 * @param content Full content to save
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 * @returns Artifact ID (numeric string)
	 */
	async save(content: string, toolType: string): Promise<string> {
		const { state, allocation } = await this.#allocate(toolType);
		// Pin the write location the direct save is about to use, then settle
		// the lease so a relocation that raced the write still lands the
		// finalized bytes in the current root.
		state.openPath = allocation.path;
		await writeArtifact(allocation.path as string, content);
		await this.#completeAllocation(state);
		return state.id;
	}

	/**
	 * Check if an artifact exists.
	 * @param id Artifact ID (numeric string)
	 */
	async exists(id: string): Promise<boolean> {
		return (await this.getPath(id)) !== null;
	}

	/**
	 * List all artifact files in the directory.
	 * Returns empty array if directory doesn't exist.
	 */
	async listFiles(): Promise<string[]> {
		await this.whenReady();
		try {
			return await fs.readdir(this.#dir);
		} catch {
			return [];
		}
	}

	/**
	 * Get the full path to an artifact file.
	 * Returns null if artifact doesn't exist.
	 *
	 * During a relocation an outstanding allocation whose finalized bytes have
	 * not landed in the current root yet resolves to its owned open location —
	 * the exact allocation this manager issued, never a global path alias.
	 *
	 * @param id Artifact ID (numeric string)
	 */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		if (match) return path.join(this.#dir, match);
		const outstanding = this.#allocations.get(id);
		if (outstanding?.openPath) {
			const stat = await fs.stat(outstanding.openPath).catch(() => null);
			if (stat?.isFile()) return outstanding.openPath;
		}
		return null;
	}
}

/**
 * Move `source` to `target`, both inside artifact storage. A `target` that
 * already exists is replaced ONLY when its bytes are a prefix of the source —
 * that is this allocation's own stale snapshot copied by a relocation seed
 * while the writer was still appending. Any other occupant is unrelated data
 * and fails the move closed.
 */
async function moveOwnedArtifactFile(source: string, target: string): Promise<void> {
	const sourceBytes = await fs.readFile(source);
	const targetBytes = await fs.readFile(target).catch(error => {
		if (isEnoent(error)) return null;
		throw error;
	});
	if (targetBytes !== null) {
		const isOwnStaleSnapshot =
			targetBytes.length <= sourceBytes.length && sourceBytes.subarray(0, targetBytes.length).equals(targetBytes);
		if (!isOwnStaleSnapshot) {
			throw new Error(`Refusing to overwrite unrelated artifact data at ${target}`);
		}
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await fs.rename(source, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await fs.copyFile(source, target);
		await fs.unlink(source);
	}
}
