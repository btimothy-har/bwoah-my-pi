import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import {
	collectIsolationCleanup,
	ISOLATION_GC_LOCK_STEM,
	managedSourceWrapper,
	removeAuthorizedWrapper,
	withIsolationMetadataLock,
} from "@oh-my-pi/pi-coding-agent/task/isolation-cleanup";
import {
	currentIsolationClaim,
	currentIsolationOwner,
	isIsolationOwnerLive,
	ISOLATION_CLEANUP_FILE,
	ISOLATION_OWNER_FILE,
	readIsolationCleanup,
	readIsolationOwner,
	writeIsolationCleanup,
	writeIsolationOwner,
	type IsolationCleanupRecord,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { __internalsForTesting, normalizePathForComparison, setWorktreesDir } from "@oh-my-pi/pi-utils";

const { tryAcquireLock, getLockPath } = __internalsForTesting;

/**
 * Regression coverage for automatic reclamation: only wrappers carrying a
 * valid cleanup record with verified recovery evidence (or an explicit/discard
 * authorization) and a positively dead owner may be removed. Everything else —
 * live owners, parked clones, legacy shells, retained recovery workspaces —
 * must survive.
 */
describe("isolation cleanup collector", () => {
	let base: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-cleanup-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(base, { recursive: true, force: true });
	});

	/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	function record(overrides: Partial<IsolationCleanupRecord> = {}): IsolationCleanupRecord {
		return {
			version: 1,
			generation: "gen-1",
			backend: natives.IsoBackendKind.Rcopy,
			detached: true,
			disposition: "preserve",
			state: "ready",
			authorization: { kind: "explicit" },
			...overrides,
		};
	}

	async function makeSandbox(name: string, overrides: Partial<IsolationCleanupRecord> = {}): Promise<string> {
		const dir = path.join(base, name);
		await fs.mkdir(path.join(dir, "m", "sub"), { recursive: true });
		await fs.mkdir(path.join(dir, "m", ".git"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "payload\n");
		await writeIsolationOwner(dir, await currentIsolationOwner(name.slice(1)));
		await writeIsolationCleanup(dir, record(overrides));
		return dir;
	}

	it("removes a dead ready clone and preserves live, parked, and legacy ones", async () => {
		const dead = await makeSandbox("taaaa00001");
		const deadOwner = await readIsolationOwner(dead);
		await fs.rm(path.join(dead, ISOLATION_OWNER_FILE), { force: true });
		// Simulate a dead original owner by stamping the record with a dead claim
		// and rewriting the owner with a reaped pid.
		await Bun.write(
			path.join(dead, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: deadOwner?.id ?? "dead0001" }),
		);

		const live = await makeSandbox("tbbbb00002", { state: "active", authorization: undefined });
		const parked = await makeSandbox("tcccc00003", { state: "active", authorization: undefined });
		const legacy = path.join(base, "tdddd00004");
		await fs.mkdir(path.join(legacy, "m"), { recursive: true });
		await Bun.write(path.join(legacy, "m", "work.txt"), "legacy\n");

		const report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(1);
		await expect(fs.stat(dead)).rejects.toThrow();
		await expect(Bun.file(path.join(live, "m", "work.txt")).exists()).resolves.toBe(true);
		await expect(Bun.file(path.join(parked, "m", "work.txt")).exists()).resolves.toBe(true);
		await expect(Bun.file(path.join(legacy, "m", "work.txt")).exists()).resolves.toBe(true);
		expect(await readIsolationCleanup(live)).toMatchObject({ state: "active" });
	});

	it("preserves a ready clone whose recovery patch evidence is missing or altered", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanup-artifacts-"));
		const patchPath = path.join(artifactsDir, "task.patch");
		await Bun.write(patchPath, "diff --git a/a.txt b/a.txt\n+saved\n");
		const digest = new Bun.CryptoHasher("sha256").update("diff --git a/a.txt b/a.txt\n+saved\n").digest("hex");
		const missing = await makeSandbox("teeee00005", {
			authorization: {
				kind: "snapshot",
				artifacts: [{ path: path.join(artifactsDir, "gone.patch"), sha256: digest }],
			},
		});
		const altered = await makeSandbox("tffff00006", {
			authorization: { kind: "snapshot", artifacts: [{ path: patchPath, sha256: "0".repeat(64) }] },
		});

		const report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(0);
		await expect(Bun.file(path.join(missing, "m", "work.txt")).exists()).resolves.toBe(true);
		await expect(Bun.file(path.join(altered, "m", "work.txt")).exists()).resolves.toBe(true);
	});

	it("reclaims a snapshot-authorized dead clone whose evidence verifies", async () => {
		// Positive control for the evidence gate: valid digest → removed. A
		// regression inverting verifyRecoveryArtifacts' acceptance would
		// otherwise permanently keep every snapshot-authorized clone.
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanup-artifacts-"));
		const patchPath = path.join(artifactsDir, "task.patch");
		await Bun.write(patchPath, "diff --git a/a.txt b/a.txt\n+saved\n");
		const digest = new Bun.CryptoHasher("sha256").update("diff --git a/a.txt b/a.txt\n+saved\n").digest("hex");
		const dir = await makeSandbox("taaaa10001", {
			authorization: { kind: "snapshot", artifacts: [{ path: patchPath, sha256: digest }] },
		});
		// makeSandbox stamps the live test process; the sweep needs a dead owner.
		await Bun.write(path.join(dir, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "aaaa10001" }));
		const report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(1);
		await expect(fs.stat(dir)).rejects.toThrow();
	});

	it("preserves retained workspaces and skips the trash container as a stray", async () => {
		const retained = await makeSandbox("taaaa00007", { state: "retained" });
		// A dead owner with an explicit authorization would otherwise be
		// reclaimable — the retained state must win.
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "retain7" }),
		);

		await collectIsolationCleanup(base, { owner: "dead" });

		await expect(Bun.file(path.join(retained, "m", "work.txt")).exists()).resolves.toBe(true);
		expect(await readIsolationCleanup(retained)).toMatchObject({ state: "retained" });
	});

	it("reclaims a dead trash child through the container", async () => {
		const trash = path.join(base, ".trash");
		const dir = path.join(trash, "ttrash008.gen-1");
		await fs.mkdir(path.join(dir, "m"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "payload\n");
		await writeIsolationCleanup(dir, record({ generation: "gen-1", state: "trash" }));
		await Bun.write(path.join(dir, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "trash8" }));

		const report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(1);
		await expect(fs.stat(dir)).rejects.toThrow();
	});

	it("skips an entry whose collector claim is live and resumes a dead one", async () => {
		const claimed = await makeSandbox("tcccc00009", { state: "deleting", claim: await currentIsolationClaim() });
		const dead = await makeSandbox("tdddd00010", { state: "deleting", claim: { pid: await deadPid() } });
		// The dead-claim entry's original owner is gone too: only its claim
		// (dead) and authorization allow the resume.
		await Bun.write(path.join(dead, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "dddd00010" }));
		const report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(1);
		await expect(Bun.file(path.join(claimed, "m", "work.txt")).exists()).resolves.toBe(true);
		await expect(fs.stat(dead)).rejects.toThrow();
	});

	it("keeps a source pinned while a surviving dependent borrows it, then reclaims child-first", async () => {
		const source = await makeSandbox("teeee00011", { state: "ready" });
		const child = await makeSandbox("tffff00012", {
			state: "active",
			authorization: undefined,
			sourceBaseDir: source,
		});
		// Both owners are dead; the child's record is active (crashed run): the
		// child survives and pins the source.
		await Bun.write(path.join(child, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "child012" }));
		await Bun.write(
			path.join(source, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "eeee00011" }),
		);

		let report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(0);
		await expect(Bun.file(path.join(source, "m", "work.txt")).exists()).resolves.toBe(true);
		await expect(Bun.file(path.join(child, "m", "work.txt")).exists()).resolves.toBe(true);

		// Authorize the child (as a completed release would): now both go,
		// child before source.
		await writeIsolationCleanup(child, {
			...(await readIsolationCleanup(child))!,
			state: "ready",
			authorization: { kind: "explicit" },
		});
		report = await collectIsolationCleanup(base, { owner: "dead" });
		expect(report.removed).toBe(2);
		await expect(fs.stat(child)).rejects.toThrow();
		await expect(fs.stat(source)).rejects.toThrow();
	});

	it("removeAuthorizedWrapper clears an explicitly authorized wrapper and its metadata last", async () => {
		const dir = await makeSandbox("taaaa00013", { state: "ready", authorization: { kind: "explicit" } });

		await removeAuthorizedWrapper(base, dir);

		await expect(fs.stat(dir)).rejects.toThrow();
	});

	it("refuses to touch malformed cleanup records", async () => {
		const dir = await makeSandbox("tbbbb00014");
		await Bun.write(path.join(dir, ISOLATION_CLEANUP_FILE), "{ not json");
		await Bun.write(path.join(dir, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "bad0014" }));

		const report = await collectIsolationCleanup(base, { owner: "dead" });

		expect(report.removed).toBe(0);
		await expect(Bun.file(path.join(dir, "m", "work.txt")).exists()).resolves.toBe(true);
	});

	it("maps a nested repo path to its managed source wrapper", () => {
		const wrapper = path.join(base, "t123456789");
		expect(managedSourceWrapper(base, path.join(wrapper, "m", "packages", "nested"))).toBe(wrapper);
		expect(managedSourceWrapper(base, path.join(base, ".trash", "t123456789.gen", "m"))).toBe(
			path.join(base, ".trash", "t123456789.gen"),
		);
		expect(managedSourceWrapper(base, path.join(base, "my-named-worktree", "sub"))).toBeUndefined();
		expect(managedSourceWrapper(base, "/elsewhere/repo")).toBeUndefined();
	});
});

/**
 * Regression coverage for the in-process root queue ahead of the OS lease:
 * many task launches against one worktree root must serialize FIFO without
 * overlapping sections or burning the bounded OS retry budget, while the
 * background collector's `{ retries: 1 }` skip must keep failing fast.
 */
describe("isolation metadata lock queue", () => {
	let base: string;
	const extraDirs: string[] = [];

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-lock-"));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
		await Promise.all(extraDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("runs same-root sections FIFO without overlap, across alias spellings", async () => {
		// A symlink spelling of the same root: identical canonical identity,
		// different lexical path. It must join the same queue and lease.
		const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-lock-alias-"));
		extraDirs.push(aliasParent);
		const alias = path.join(aliasParent, "root");
		await fs.symlink(base, alias);
		const order: string[] = [];
		let active = 0;
		let maxActive = 0;
		const gate = Promise.withResolvers<void>();
		const section = (name: string, root: string, hold: boolean) =>
			withIsolationMetadataLock(root, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				try {
					if (hold) await gate.promise;
					order.push(name);
				} finally {
					active -= 1;
				}
			});
		// Synchronous admissions fix the queue order; the first section holds
		// the lease until every later call has queued behind it. The alias
		// spelling must join the SAME queue, not a parallel one.
		const first = section("first", base, true);
		const rest = [section("second", alias, false), section("third", base, false), section("fourth", alias, false)];
		gate.resolve();
		await Promise.all([first, ...rest]);
		expect(order).toEqual(["first", "second", "third", "fourth"]);
		expect(maxActive).toBe(1);
	});

	it("lets an independent root proceed while another root's section is held", async () => {
		const other = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-lock-other-"));
		extraDirs.push(other);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const events: string[] = [];
		const held = withIsolationMetadataLock(base, async () => {
			events.push("held:start");
			started.resolve();
			await gate.promise;
			events.push("held:end");
		});
		await started.promise;
		await withIsolationMetadataLock(other, async () => {
			events.push("other");
		});
		expect(events).toEqual(["held:start", "other"]);
		gate.resolve();
		await held;
		expect(events).toEqual(["held:start", "other", "held:end"]);
	});

	it("releases the lease after a throwing section and keeps successors in order", async () => {
		const order: string[] = [];
		const failing = withIsolationMetadataLock(base, async () => {
			order.push("failing");
			throw new Error("boom");
		});
		const successor = withIsolationMetadataLock(base, async () => {
			order.push("successor");
		});
		await expect(failing).rejects.toThrow("boom");
		await successor;
		expect(order).toEqual(["failing", "successor"]);
		// The OS lease was really released: a fresh section acquires immediately.
		await withIsolationMetadataLock(base, async () => {
			order.push("after");
		});
		expect(order).toEqual(["failing", "successor", "after"]);
	});

	it("fails retries:1 immediately under local contention and never runs the section later", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const order: string[] = [];
		const held = withIsolationMetadataLock(base, async () => {
			order.push("held");
			started.resolve();
			await gate.promise;
		});
		await started.promise;
		// A locally queued waiter (not yet holding the lease) is contention too.
		const waiter = withIsolationMetadataLock(base, async () => {
			order.push("waiter");
		});
		let skippedRan = false;
		const skipped = withIsolationMetadataLock(
			base,
			async () => {
				skippedRan = true;
			},
			{ retries: 1 },
		);
		await expect(skipped).rejects.toThrow("Failed to acquire lock");
		expect(skippedRan).toBe(false);
		gate.resolve();
		// The queue fully drains here; the skipped section never entered the
		// FIFO (it was rejected at admission), so it cannot run later either.
		await Promise.all([held, waiter]);
		expect(order).toEqual(["held", "waiter"]);
		expect(skippedRan).toBe(false);
		// The queue settled cleanly: a later background attempt succeeds.
		await withIsolationMetadataLock(
			base,
			async () => {
				skippedRan = true;
			},
			{ retries: 1 },
		);
		expect(skippedRan).toBe(true);
	});

	it("makes one OS attempt for retries:1 against an external holder; normal calls wait for handoff", async () => {
		// Hold the real canonical lease the way another process would.
		const canonical = normalizePathForComparison(base);
		const external = tryAcquireLock(getLockPath(path.join(canonical, ISOLATION_GC_LOCK_STEM)));
		if (!external) throw new Error("fixture failed to acquire the root lease");
		try {
			// No local queue active: a background skip performs one OS attempt
			// and settles as contention instead of retrying forever.
			let skipRan = false;
			await expect(
				withIsolationMetadataLock(
					base,
					async () => {
						skipRan = true;
					},
					{ retries: 1 },
				),
			).rejects.toThrow("Failed to acquire lock");
			expect(skipRan).toBe(false);

			// A normal local call waits on the OS lease rather than entering.
			let entered = false;
			const waiting = withIsolationMetadataLock(base, async () => {
				entered = true;
			});
			// Flush microtasks so the first OS acquisition attempt has run: with
			// the external lease held it must fail and wait (a canonicalization
			// split would let it acquire a DIFFERENT lock file instantly).
			for (let flush = 0; flush < 10; flush++) await Promise.resolve();
			expect(entered).toBe(false);
			external.release();
			await waiting;
			expect(entered).toBe(true);
		} finally {
			external.release();
		}
	});
});

/**
 * The optional current-process token snapshot must preserve the liveness
 * contract: it substitutes the fresh token probe only for THIS process, a
 * token mismatch still means a recycled pid, and an unavailable snapshot
 * (`null`) stays conservative. Foreign pids always re-probe.
 */
describe("isolation owner liveness token snapshot", () => {
	it("keeps a matching snapshot live and a mismatching one recycled for the current pid", async () => {
		const claim = await currentIsolationClaim();
		if (claim.startToken === undefined) {
			// Windows reports no start token: pid-only liveness, snapshot irrelevant.
			await expect(isIsolationOwnerLive({ pid: process.pid }, null)).resolves.toBe(true);
			return;
		}
		const token = claim.startToken;
		await expect(isIsolationOwnerLive({ pid: process.pid, startToken: token }, token)).resolves.toBe(true);
		// Recorded token no longer matches this process instance: recycled.
		await expect(
			isIsolationOwnerLive({ pid: process.pid, startToken: "not-the-current-token" }, token),
		).resolves.toBe(false);
	});

	it("treats an unavailable snapshot conservatively and re-probes foreign pids", async () => {
		// null = the platform could not report a token: never proof of death.
		await expect(isIsolationOwnerLive({ pid: process.pid, startToken: "not-the-current-token" }, null)).resolves.toBe(
			true,
		);
		// A reaped pid (spawned and exited, so kill reports ESRCH) is dead
		// regardless of any snapshot.
		const reaped = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await reaped.exited;
		await expect(isIsolationOwnerLive({ pid: reaped.pid }, null)).resolves.toBe(false);
		if (process.platform === "win32") return;
		// A foreign live pid is probed fresh; the current-process snapshot must
		// not be applied to it. Its real token differs from the recorded one.
		const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			const claim = await currentIsolationClaim();
			await expect(
				isIsolationOwnerLive({ pid: child.pid, startToken: "not-the-child-token" }, claim.startToken ?? null),
			).resolves.toBe(false);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
