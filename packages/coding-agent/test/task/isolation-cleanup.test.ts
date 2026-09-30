import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import {
	collectIsolationCleanup,
	managedSourceWrapper,
	removeAuthorizedWrapper,
} from "@oh-my-pi/pi-coding-agent/task/isolation-cleanup";
import {
	currentIsolationClaim,
	ISOLATION_CLEANUP_FILE,
	ISOLATION_OWNER_FILE,
	readIsolationCleanup,
	readIsolationOwner,
	writeIsolationCleanup,
	writeIsolationOwner,
	type IsolationCleanupRecord,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

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
		await writeIsolationOwner(dir, name.slice(1));
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
