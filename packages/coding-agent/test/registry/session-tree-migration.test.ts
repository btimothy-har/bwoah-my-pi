/**
 * Regression coverage for the storage-only root migration coordinator:
 * chained relocations of one continuing owner are serialized (a B→C migration
 * never scans descendants before the A→B rebase placed them), and a failed
 * seed/rebase fails closed — parked refs keep their old paths, the roster
 * refuses to scan the unproven root, and no still-owned ref is replaced by a
 * stale seeded copy.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { handleSessionFileChange } from "@oh-my-pi/pi-coding-agent/registry/session-tree-migration";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionFileChange } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-25T10:00:00.000Z",
		cwd: "/tmp",
	});
}

/** A live-child stand-in: only the rebase entry point is exercised. */
function stubLiveSession(rebaseLog: string[]): AgentSession {
	return {
		sessionManager: {
			rebaseSessionFile: async (target: string) => {
				rebaseLog.push(target);
			},
		},
	} as unknown as AgentSession;
}

/** Root file and child transcript stems for one relocation generation. */
function treePaths(dir: string, generation: string): { root: string; live: string; parked: string } {
	return {
		root: path.join(dir, "tree", `${generation}.jsonl`),
		live: path.join(dir, "tree", generation, "Live.jsonl"),
		parked: path.join(dir, "tree", generation, "Parked.jsonl"),
	};
}

async function writeTree(paths: { root: string; live: string; parked: string }): Promise<void> {
	await Bun.write(paths.root, `${sessionHeader(path.basename(paths.root, ".jsonl"))}\n`);
	await Bun.write(paths.live, `${sessionHeader("live")}\n`);
	await Bun.write(paths.parked, `${sessionHeader("parked")}\n`);
}

function change(from: string, to: string, generation: number, ready: Promise<void>): SessionFileChange {
	return { from, to, generation, reason: "recovery", ready };
}

/** Flush the (finite, IO-free) promise chains gating migration serialization. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Spy on `fs.promises.readdir`, recording each scanned directory. */
function spyOnReaddirs(readdirs: string[]): void {
	const realReaddir = fsp.readdir;
	vi.spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike) => {
		readdirs.push(String(target));
		return realReaddir(target, { withFileTypes: true });
	}) as unknown as typeof fsp.readdir);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session tree migration", () => {
	it("serializes chained owner migrations so a live child is never stranded mid-rebase", async () => {
		using tempDir = TempDir.createSync("@omp-tree-migration-chained-");
		const dir = tempDir.path();
		const a = treePaths(dir, "a");
		const b = treePaths(dir, "b");
		const c = treePaths(dir, "c");
		// b/ and c/ hold the seeded copies each recovery would have placed.
		await Promise.all([writeTree(a), writeTree(b), writeTree(c)]);

		const registry = new AgentRegistry();
		const mainRef = registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: a.root,
		});
		const rebaseLog: string[] = [];
		const liveRef = registry.register({
			id: "Live",
			displayName: "Live",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: stubLiveSession(rebaseLog),
			sessionFile: a.live,
			status: "running",
		});
		const parkedRef = registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: a.parked,
			status: "parked",
		});

		const gateB = Promise.withResolvers<void>();
		const gateC = Promise.withResolvers<void>();
		handleSessionFileChange(registry, MAIN_AGENT_ID, mainRef, change(a.root, b.root, 1, gateB.promise), {
			root: true,
		});
		handleSessionFileChange(registry, MAIN_AGENT_ID, mainRef, change(b.root, c.root, 2, gateC.promise), {
			root: true,
		});
		// The owner's own ref follows immediately, synchronously.
		expect(mainRef.sessionFile).toBe(c.root);

		// C's seed resolves first: C's migration still waits behind B's, so no
		// rebase or repoint has happened yet.
		gateC.resolve();
		await flushMicrotasks();
		expect(rebaseLog).toEqual([]);
		expect(liveRef.sessionFile).toBe(a.live);
		expect(parkedRef.sessionFile).toBe(a.parked);

		// Settle B: the serialized chain rebases live B then C, repoints the
		// parked ref through both generations, and the roster scan of C (barrier
		// joined) is the synchronization point.
		gateB.resolve();
		await ensurePersistedRoster(registry, c.root);
		expect(rebaseLog).toEqual([b.live, c.live]);
		expect(liveRef.sessionFile).toBe(c.live);
		expect(parkedRef.sessionFile).toBe(c.parked);
		// Exact ref objects survived: no unregister/re-register anywhere.
		expect(registry.get("Live")).toBe(liveRef);
		expect(registry.get("Parked")).toBe(parkedRef);
	}, 10_000);

	it("fails closed on a rejected seed: parked refs stay, live children rebase, and the roster refuses the unproven root", async () => {
		using tempDir = TempDir.createSync("@omp-tree-migration-seed-fail-");
		const dir = tempDir.path();
		const a = treePaths(dir, "a");
		const b = treePaths(dir, "b");
		const c = treePaths(dir, "c");
		// Only a/ and c/ exist: the a→b seed failed, so b/ never materialized.
		await Promise.all([writeTree(a), writeTree(c)]);

		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		const mainRef = registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: a.root,
		});
		const rebaseLog: string[] = [];
		const liveRef = registry.register({
			id: "Live",
			displayName: "Live",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: stubLiveSession(rebaseLog),
			sessionFile: a.live,
			status: "running",
		});
		const parkedRef = registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: a.parked,
			status: "parked",
		});

		const gateB = Promise.withResolvers<void>();
		handleSessionFileChange(registry, MAIN_AGENT_ID, mainRef, change(a.root, b.root, 1, gateB.promise), {
			root: true,
		});
		// Reject only after the migration chain has attached its handlers.
		await flushMicrotasks();
		gateB.reject(new Error("simulated seed failure"));

		// The failed migration's barrier stays latched: roster calls for b/
		// degrade to in-memory peers without scanning the unproven root.
		expect(await ensurePersistedRoster(registry, b.root)).toBe(b.root);
		expect(readdirs.filter(target => target === path.join(dir, "tree", "b"))).toEqual([]);
		expect(await ensurePersistedRoster(registry, b.root)).toBe(b.root);
		expect(readdirs.filter(target => target === path.join(dir, "tree", "b"))).toEqual([]);

		// The live child still left the foreign root; the parked ref keeps its
		// old (still readable) path; both are the same ref objects.
		expect(rebaseLog).toEqual([b.live]);
		expect(liveRef.sessionFile).toBe(b.live);
		expect(parkedRef.sessionFile).toBe(a.parked);
		expect(registry.get("Live")).toBe(liveRef);
		expect(registry.get("Parked")).toBe(parkedRef);

		// A superseding successful relocation certifies the new root: the live
		// child follows it; the parked ref stays at a/ (its bytes never reached
		// b/, so c/ never seeded them either — fail-closed, not blind prefix).
		const gateC = Promise.withResolvers<void>();
		handleSessionFileChange(registry, MAIN_AGENT_ID, mainRef, change(b.root, c.root, 2, gateC.promise), {
			root: true,
		});
		gateC.resolve();
		expect(await ensurePersistedRoster(registry, c.root)).toBe(c.root);
		expect(rebaseLog).toEqual([b.live, c.live]);
		expect(liveRef.sessionFile).toBe(c.live);
		expect(parkedRef.sessionFile).toBe(a.parked);
	}, 10_000);
});
