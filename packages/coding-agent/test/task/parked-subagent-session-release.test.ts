/**
 * A kept-alive subagent that parks must release its AgentSession while its
 * adoption (and therefore revivability) survives. The lifecycle manager holds
 * the run's reviver closure for as long as the agent stays adopted, so anything
 * that closure keeps reachable is retained for the life of the process; a
 * reviver that pins the disposed session leaks one full session graph per
 * spawned subagent.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager, type SessionFileChange } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "ParkedRelease";
const RECOVERY_AGENT_ID = "ParkedRecovery";
const MOCK_API_SOURCE = "test/parked-subagent-session-release";

/** Runs `race` just before each atomic publish to `raced`, as a writer without the lease appending inside every read-back window. */
class RacedStorage extends FileSessionStorage {
	race: (() => void) | undefined;
	raced: string | undefined;

	override writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.raced !== undefined && path.resolve(fpath) === path.resolve(this.raced)) this.race?.();
		return super.writeTextAtomic(fpath, content, options);
	}
}
// createAgentSession races its workspace scan against an uncancelled 5 s
// startup deadline timer whose reaction keeps the new session reachable until
// it fires; collection is polled past that window.
const COLLECT_DEADLINE_MS = 8_000;

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-release-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

/** Kept out of the test body so no strong local binding outlives the capture. */
function weakRefToLiveSession(id: string): WeakRef<AgentSession> {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`subagent ${id} has no live session to observe`);
	return new WeakRef(session);
}

async function collected(ref: WeakRef<AgentSession>, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(100);
	}
}

it("releases a parked keep-alive subagent's session while the agent stays revivable", async () => {
	const cwd = path.join(root, "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				// No TTL timer: the test parks explicitly through the same path the timer takes.
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);

		const sessionRef = weakRefToLiveSession(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		expect(AgentRegistry.global().get(AGENT_ID)).toMatchObject({ status: "parked", session: null });
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);

		// Recorded mock calls carry stream options with closures bound to the session.
		mock.reset();
		availableSpy.mockRestore();
		expect(await collected(sessionRef, COLLECT_DEADLINE_MS)).toBe(true);
		// Still adopted after collection: the release did not come from dropping the reviver.
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);
	} finally {
		authStorage.close();
	}
}, 20_000);

it("keeps a parked subagent's ref and adoption through a root storage-only recovery", async () => {
	const cwd = path.join(root, "work");
	const sessionsDir = path.join(root, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sessionsDir, { recursive: true });

	const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

	// The root session is opened through a storage that can be armed to race
	// every atomic publish, driving the contested-write recovery to a sibling.
	const storage = new RacedStorage();
	const parent = SessionManager.create(cwd, sessionsDir, storage);
	parent.appendMessage(userTurn("root turn before the conflict"));
	await parent.ensureOnDisk();
	await parent.flush();
	const rootFileA = parent.getSessionFile();
	if (!rootFileA) throw new Error("Expected root session file");
	// Child transcripts live inside the root's artifact tree (<rootStem>/<id>.jsonl).
	const artifactsDirA = rootFileA.slice(0, -".jsonl".length);

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const onRelease = vi.fn(() => Promise.resolve());

	let rootSession: AgentSession | undefined;
	let competitor: SessionManager | undefined;
	try {
		({ session: rootSession } = await createAgentSession({
			cwd,
			agentDir: path.join(root, "agent"),
			sessionManager: parent,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			model: mock,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
			skipPythonPreflight: true,
			hasUI: false,
		}));
		await parent.flush();

		const result = await runSubprocess({
			cwd,
			artifactsDir: artifactsDirA,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: RECOVERY_AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
			onRelease,
		});
		expect(result.exitCode).toBe(0);
		const ref = AgentRegistry.global().get(RECOVERY_AGENT_ID);
		if (!ref) throw new Error(`subagent ${RECOVERY_AGENT_ID} has no registry ref after its run`);

		await AgentLifecycleManager.global().park(RECOVERY_AGENT_ID);
		const childFileA = path.join(artifactsDirA, `${RECOVERY_AGENT_ID}.jsonl`);
		expect(ref).toMatchObject({ status: "parked", session: null });
		await fs.stat(childFileA);

		// A second writer without the lease appends inside every read-back
		// window until the root manager leaves the contested file to it.
		const theirs = await SessionManager.open(rootFileA, sessionsDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		competitor = theirs;
		const changes: SessionFileChange[] = [];
		const unsubscribeChanges = parent.onSessionFileChanged(change => changes.push(change));
		let racing = 0;
		storage.raced = rootFileA;
		storage.race = () => {
			theirs.appendMessage(userTurn(`racing turn ${racing++}`));
		};
		try {
			await parent.rewriteEntries();
			parent.appendMessage(userTurn("root turn after the conflict"));
			await parent.flush();
		} finally {
			storage.race = undefined;
			unsubscribeChanges();
		}

		const rootFileB = parent.getSessionFile();
		if (!rootFileB) throw new Error("Expected root session file after recovery");
		expect(rootFileB).not.toBe(rootFileA);
		expect(changes).toHaveLength(1);
		await changes[0]!.ready;

		// The descendant migration is registered as a roster barrier on the new
		// root: this scan deterministically awaits the rebase (parked refs move
		// only once the seed lands the bytes under the new root) and must then
		// observe — never replace — the already-migrated ref.
		await ensurePersistedRoster(AgentRegistry.global(), rootFileB);
		const artifactsDirB = rootFileB.slice(0, -".jsonl".length);
		const childFileB = path.join(artifactsDirB, `${RECOVERY_AGENT_ID}.jsonl`);
		expect(AgentRegistry.global().get(RECOVERY_AGENT_ID)).toBe(ref);
		expect(ref.sessionFile).toBe(childFileB);
		expect(ref).toMatchObject({ status: "parked", session: null });
		expect(AgentLifecycleManager.global().has(RECOVERY_AGENT_ID, ref)).toBe(true);

		// Revival reopens the rebased transcript; the header cwd survives.
		const revived = await AgentLifecycleManager.global().ensureLive(RECOVERY_AGENT_ID);
		expect(revived.sessionManager.getSessionFile()).toBe(childFileB);
		expect(revived.sessionManager.getCwd()).toBe(cwd);

		// Release settles the revived session and fires the run's release hook once.
		expect(await AgentLifecycleManager.global().release(RECOVERY_AGENT_ID, ref)).toBe(true);
		expect(onRelease).toHaveBeenCalledTimes(1);
	} finally {
		availableSpy.mockRestore();
		if (rootSession) await rootSession.dispose();
		if (competitor) await competitor.close();
		authStorage.close();
	}
}, 30_000);
