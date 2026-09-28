import { afterEach, describe, expect, it, vi } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as discovery from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();
const tempDirs = new Set<string>();

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workpool-bridge-"));
	tempDirs.add(dir);
	await $`git init -q -b main`.cwd(dir).quiet();
	return dir;
}

async function makeSession(): Promise<ToolSession> {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	return {
		cwd: await makeRepo(),
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.enableLsp": false,
		}),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	};
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
	tempDirs.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = await makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toThrow("arguments must be an object");
		await expect(runEvalWorkpool({}, { session })).rejects.toThrow("requires an op");
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toThrow(
			"agent must be a non-empty string",
		);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toThrow(
			"requires a non-empty name",
		);
	});

	it("rejects unknown pool names", async () => {
		const session = await makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toThrow(
			'unknown workpool "missing"',
		);
	});

	it("rejects obsolete spawn keys and non-boolean readOnly at create", async () => {
		const session = await makeSession();
		for (const key of ["isolated", "apply", "merge"]) {
			await expect(runEvalWorkpool({ op: "create", agent: "scout", [key]: true }, { session })).rejects.toThrow(
				`workpool create does not accept "${key}"`,
			);
		}
		await expect(runEvalWorkpool({ op: "create", agent: "scout", readOnly: "yes" }, { session })).rejects.toThrow(
			"workpool readOnly must be a boolean",
		);
	});

	it("creates unique default names and validates push and peek arguments", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = await makeSession();
		const events: Array<Record<string, unknown>> = [];
		const first = await runEvalWorkpool(
			{ op: "create", agent: "scout" },
			{ session, emitStatus: event => events.push(event) },
		);
		const second = await runEvalWorkpool({ op: "create", agent: "scout" }, { session });
		expect(first).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(second).toEqual({ name: "scout-pool-2", agent: "scout", limit: 2 });
		expect(events).toEqual([{ op: "workpool", action: "create", pool: "scout-pool", count: 2 }]);
		await expect(runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session })).rejects.toThrow(
			"items string array",
		);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toThrow(
			'unknown workpool operation "wait"',
		);
	});
});
