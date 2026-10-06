import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager concurrent first-use", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	// First-use init (dir scan → #nextId seed) must run exactly once. Two callers
	// racing a fresh manager both yield inside #scanExistingIds before either
	// marks init done; if the second re-seeds #nextId after the first consumed an
	// id, both allocate the same numeric id and the second write clobbers the
	// first. Same toolType => file overwrite; the first id resolves to B's bytes.
	it("hands concurrent same-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("CONTENT-A", "bash"), mgr.save("CONTENT-B", "bash")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(pathA).not.toBeNull();
		expect(pathB).not.toBeNull();
		expect(await Bun.file(pathA as string).text()).toBe("CONTENT-A");
		expect(await Bun.file(pathB as string).text()).toBe("CONTENT-B");
	});

	// Different toolTypes turn a duplicate id into two coexisting files
	// (`{id}.bash.log` + `{id}.async.log`); getPath's startsWith(`${id}.`) then
	// resolves ambiguously in unspecified readdir order. Distinct ids keep each
	// artifact:// pointing at the content its caller wrote.
	it("hands concurrent different-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("BASH-BYTES", "bash"), mgr.save("ASYNC-BYTES", "async")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(await Bun.file(pathA as string).text()).toBe("BASH-BYTES");
		expect(await Bun.file(pathB as string).text()).toBe("ASYNC-BYTES");
	});

	// The race also re-opens on a fresh manager over a directory that already
	// holds artifacts (e.g. after a `#artifactManager = null` reset): the scan
	// seeds from maxId, and concurrent callers must still get ids past it.
	it("does not reuse ids when racing init over a pre-populated directory", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir);
		await seed.save("OLD", "bash");

		const mgr = new ArtifactManager(dir);
		const [idA, idB] = await Promise.all([mgr.save("NEW-A", "bash"), mgr.save("NEW-B", "bash")]);

		expect(idA).not.toBe(idB);
		expect(await Bun.file((await mgr.getPath(idA)) as string).text()).toBe("NEW-A");
		expect(await Bun.file((await mgr.getPath(idB)) as string).text()).toBe("NEW-B");
	});
});

describe("ArtifactManager storage-only relocation", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	// Contested-write recovery keeps ONE manager object shared by the parent and
	// its adopted children. A fresh allocator per root would rescan the seeded
	// directory and hand out ids the other writer already owns — the collision
	// this regression pins: both sides allocated id 1 and the parent link
	// resolved the parent's bytes.
	it("keeps one monotonic id space across rebinds, even onto an unseeded directory", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const mgr = new ArtifactManager(dirA);
		const first = await mgr.save("AT-A", "bash");

		// Recovery rebound the shared object; the seed has not copied anything yet.
		mgr.rebind(dirB, Promise.resolve());
		const [childId, parentId] = await Promise.all([mgr.save("CHILD", "bash"), mgr.save("PARENT", "bash")]);

		expect(Number(childId)).toBeGreaterThan(Number(first));
		expect(Number(parentId)).toBeGreaterThan(Number(first));
		expect(childId).not.toBe(parentId);
		expect(path.dirname((await mgr.getPath(childId)) as string)).toBe(dirB);
		expect(await Bun.file((await mgr.getPath(childId)) as string).text()).toBe("CHILD");
		expect(await Bun.file((await mgr.getPath(parentId)) as string).text()).toBe("PARENT");
		// The pre-rebind artifact is gone from the new root until the seed lands:
		// it must not resolve to wrong bytes, and after the seed copies it, the
		// SAME id resolves there.
		expect(await mgr.getPath(first)).toBeNull();
		const seededName = `${first}.bash.log`;
		await fs.mkdir(dirB, { recursive: true });
		await fs.copyFile(path.join(dirA, seededName), path.join(dirB, seededName));
		expect(await Bun.file((await mgr.getPath(first)) as string).text()).toBe("AT-A");
	});

	// An open sink keeps its descriptor at the old root while the seed copies a
	// prefix; complete() must publish the FINALIZED bytes over that stale
	// snapshot, and post-completion resolvePath must report the new root.
	it("settles an open allocation's finalized bytes into the current root, replacing its own stale seed prefix", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const mgr = new ArtifactManager(dirA);
		const allocation = await mgr.allocatePath("bash");
		const lease = allocation.lease;
		if (!lease || !allocation.id || !allocation.path) throw new Error("Expected a managed allocation");

		const openPath = await lease.resolvePath();
		expect(path.dirname(openPath)).toBe(dirA);
		await Bun.write(openPath, "prefix-bytes");

		// Recovery mid-stream: the seed copies the prefix, then the writer
		// finishes at its open location (the old root).
		await fs.mkdir(dirB, { recursive: true });
		await fs.copyFile(openPath, path.join(dirB, path.basename(openPath)));
		mgr.rebind(dirB, Promise.resolve());
		await Bun.write(openPath, "prefix-bytes-FINALIZED");
		await lease.complete();
		await lease.complete(); // memoized: a second settlement shares the first

		const finalizedPath = await lease.resolvePath();
		expect(path.dirname(finalizedPath)).toBe(dirB);
		expect(await Bun.file(finalizedPath).text()).toBe("prefix-bytes-FINALIZED");
		expect(await mgr.getPath(allocation.id)).toBe(finalizedPath);
	});

	// A destination file that is not this allocation's own snapshot belongs to
	// someone else: settlement must fail closed instead of overwriting it.
	it("fails closed when the reserved name holds unrelated data at the new root", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const mgr = new ArtifactManager(dirA);
		const allocation = await mgr.allocatePath("bash");
		const lease = allocation.lease;
		if (!lease || !allocation.id) throw new Error("Expected a managed allocation");

		const openPath = await lease.resolvePath();
		await Bun.write(openPath, "owned-bytes");
		await fs.mkdir(dirB, { recursive: true });
		const foreign = path.join(dirB, path.basename(openPath));
		await Bun.write(foreign, "uNrElAtEd data that is not a prefix of ours");
		mgr.rebind(dirB, Promise.resolve());

		await expect(lease.complete()).rejects.toThrow(/unrelated/);
		// Both copies survive: the foreign file was not clobbered and the owned
		// bytes were not silently dropped.
		expect(await Bun.file(foreign).text()).toBe("uNrElAtEd data that is not a prefix of ours");
		expect(await Bun.file(openPath).text()).toBe("owned-bytes");
		// A failed settlement must not be advertised: post-completion resolution
		// rejects rather than returning a path whose bytes never landed.
		await expect(lease.resolvePath()).rejects.toThrow(/unrelated/);
	});

	// A failed seed is not a ready root: allocations and lookups reject
	// truthfully instead of proceeding on (or advertising) an unseeded
	// directory. A later successful relocation recovers the same manager.
	it("rejects allocations and lookups after a failed seed, and recovers on the next rebind", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const mgr = new ArtifactManager(dirA);
		const first = await mgr.save("AT-A", "bash");

		mgr.rebind(dirB, Promise.reject(new Error("simulated seed failure")));
		await expect(mgr.whenReady()).rejects.toThrow("simulated seed failure");
		await expect(mgr.allocatePath("bash")).rejects.toThrow("simulated seed failure");
		await expect(mgr.getPath(first)).rejects.toThrow("simulated seed failure");

		const dirC = freshDir();
		mgr.rebind(dirC, Promise.resolve());
		const id = await mgr.save("AT-C", "bash");
		expect(Number(id)).toBeGreaterThan(Number(first));
		expect(await Bun.file((await mgr.getPath(id)) as string).text()).toBe("AT-C");
	});

	// A verified whole-directory rename carries open descriptors to the new
	// root: the pinned path is translated (exact-owner, per allocation) and
	// settlement verifies in place instead of republishing or failing against
	// the vacated path.
	it("follows outstanding open allocations across a carried (rename) rebind", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const mgr = new ArtifactManager(dirA);
		const allocation = await mgr.allocatePath("bash");
		const lease = allocation.lease;
		if (!lease || !allocation.id) throw new Error("Expected a managed allocation");
		const openPath = await lease.resolvePath();
		const handle = await fs.open(openPath, "w");
		await handle.write("part-");

		// The relocation is a real rename (what moveTo does on one device).
		await fs.mkdir(path.dirname(dirB), { recursive: true });
		await fs.rename(dirA, dirB);
		mgr.rebind(dirB, Promise.resolve(), { carried: true });

		await handle.write("final");
		await handle.close();
		await lease.complete();

		const finalized = await lease.resolvePath();
		expect(finalized).toBe(path.join(dirB, path.basename(openPath)));
		expect(await Bun.file(finalized).text()).toBe("part-final");
		expect(await mgr.getPath(allocation.id)).toBe(finalized);
	});

	// An allocation whose writer never opened a file has no bytes: settlement
	// publishes nothing and the id does not become a phantom artifact.
	it("settles an allocation that was never opened without publishing anything", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const mgr = new ArtifactManager(dirA);
		const allocation = await mgr.allocatePath("bash");
		const lease = allocation.lease;
		if (!lease || !allocation.id) throw new Error("Expected a managed allocation");

		mgr.rebind(dirB, Promise.resolve());
		await lease.complete();

		expect(await mgr.getPath(allocation.id)).toBeNull();
		expect(await mgr.exists(allocation.id)).toBe(false);
	});

	// An unopened sink resolves its open-write location only after the full
	// relocation tail settles, so it never opens a vacated (or unseeded) root —
	// including when a second relocation's seed resolves before the first's.
	// "Still pending" is proven by flushing the (finite, IO-free) microtask
	// chain rather than sleeping: the tail is pure promise composition.
	it("gates resolvePath and allocation on the chained relocation tail", async () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const dirC = freshDir();
		const mgr = new ArtifactManager(dirA);
		const flushMicrotasks = async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};

		let releaseB!: () => void;
		let releaseC!: () => void;
		const gateB = new Promise<void>(resolve => {
			releaseB = resolve;
		});
		const gateC = new Promise<void>(resolve => {
			releaseC = resolve;
		});
		mgr.rebind(dirB, gateB);
		mgr.rebind(dirC, gateC);

		// Out-of-order completion: C's seed resolves first, but the chain still
		// waits for B's.
		let tailSettled = false;
		void mgr.whenReady().then(() => {
			tailSettled = true;
		});
		releaseC();
		await flushMicrotasks();
		expect(tailSettled).toBe(false);
		releaseB();
		await mgr.whenReady();
		expect(tailSettled).toBe(true);

		// Allocations join the same tail and see the CURRENT root.
		const allocation = await mgr.allocatePath("bash");
		expect(path.dirname(allocation.path as string)).toBe(dirC);

		// So does a lease resolve issued while another relocation is in flight.
		let releaseD!: () => void;
		const dirD = freshDir();
		const gateD = new Promise<void>(resolve => {
			releaseD = resolve;
		});
		mgr.rebind(dirD, gateD);
		let resolved = false;
		const resolving = allocation.lease!.resolvePath().then(p => {
			resolved = true;
			return p;
		});
		await flushMicrotasks();
		expect(resolved).toBe(false);
		releaseD();
		expect(path.dirname(await resolving)).toBe(dirD);
	});
});
