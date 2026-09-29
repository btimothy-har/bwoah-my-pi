/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ context, tasks[] }`
 *    when on (per-spawn fields — including `outputSchema` and
 *    `schemaMode` — live in the items), the flat form exposes those fields
 *    directly. The stale `schema` field is never accepted.
 * 2. Shape validation rejects stale `schema`, `tasks`/`context` while batch
 *    is disabled, top-level `task` in batch calls, empty/invalid items,
 *    duplicate names, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

// Ordinary spawns always run in an isolated clone, so preflight probes the
// session cwd for a supported Git checkout even when execution is stubbed.
let repoDir: string;

beforeAll(async () => {
	repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-batch-repo-"));
	await $`git init -q -b main ${repoDir}`.quiet();
});

afterAll(async () => {
	await fs.rm(repoDir, { recursive: true, force: true });
});

/** Stub the clone boundary and observe the executor options handed to the runner. */
function mockIsolatedDispatch(
	impl: (options: executorModule.ExecutorOptions) => Promise<SingleResult> | SingleResult,
): void {
	vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: repoDir, baseline: null });
	vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts => impl(opts.baseOptions));
}

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
		agentId?: string;
		planMode?: boolean;
		spawns?: string;
	} = {},
): ToolSession {
	return {
		cwd: repoDir,
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => options.agentId ?? null,
		getPlanModeState: options.planMode ? () => ({ enabled: true }) : undefined,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const properties = toolWireSchema(tool).properties;
	return isRecord(properties) ? properties : {};
}

function getBatchItemProperties(tool: TaskTool): Record<string, unknown> {
	const tasks = getSchemaProperties(tool).tasks;
	if (!isRecord(tasks) || !isRecord(tasks.items) || !isRecord(tasks.items.properties)) return {};
	return tasks.items.properties;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(agent: AgentDefinition | AgentDefinition[] = taskAgent): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: Array.isArray(agent) ? agent : [agent],
		projectAgentsDir: null,
	});
}
describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.task).toBeDefined();
		expect(offProperties.name).toBeDefined();
		expect(offProperties.outputSchema).toBeDefined();
		expect(typeof offProperties.outputSchema).toBe("object");
		expect(offProperties.schemaMode).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { context, tasks[] } — the per-spawn fields live
		// only inside the task items.
		expect(onProperties.task).toBeUndefined();
		expect(onProperties.name).toBeUndefined();
		expect(onProperties.agent).toBeUndefined();
		expect(onProperties.outputSchema).toBeUndefined();
		expect(onProperties.schemaMode).toBeUndefined();
		const itemProperties = getBatchItemProperties(on);
		expect(itemProperties.task).toBeDefined();
		expect(itemProperties.name).toBeDefined();
		expect(itemProperties.agent).toBeDefined();
		expect(itemProperties.outputSchema).toBeDefined();
		expect(typeof itemProperties.outputSchema).toBe("object");
		expect(itemProperties.schemaMode).toBeDefined();
	});

	it("hides effort by default and exposes it when task.enableEffort is enabled", async () => {
		mockDiscovery();

		const flatSession = createSession({ settings: { "task.batch": false } });
		const flat = await TaskTool.create(flatSession);
		expect(getSchemaProperties(flat).effort).toBeUndefined();

		flatSession.settings.override("task.enableEffort", true);
		expect(getSchemaProperties(flat).effort).toBeDefined();

		const batchSession = createSession({ settings: { "task.batch": true } });
		const batch = await TaskTool.create(batchSession);
		expect(getBatchItemProperties(batch).effort).toBeUndefined();

		batchSession.settings.override("task.enableEffort", true);
		expect(getBatchItemProperties(batch).effort).toBeDefined();
	});

	it("exposes no disposition fields in the batch item schema; the definition owns readOnly", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const properties = getSchemaProperties(tool);
		expect(properties.isolated).toBeUndefined();
		const itemProperties = getBatchItemProperties(tool);
		expect(itemProperties.readOnly).toBeUndefined();
		expect(itemProperties.isolated).toBeUndefined();
		expect(itemProperties.apply).toBeUndefined();
		expect(itemProperties.merge).toBeUndefined();
	});

	it("rejects the removed isolated field with the definition-disposition migration error", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false } }));

		const flat = await tool.execute("tc-obsolete-flat", { task: "Work.", isolated: true } as unknown as TaskParams);
		expect(getFirstText(flat)).toContain("The `isolated` field was removed:");
		expect(getFirstText(flat)).toContain("agent definition");

		const batched = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const batch = await batched.execute("tc-obsolete-batch", {
			context: "ctx",
			tasks: [{ name: "Legacy", task: "Work.", isolated: false }],
		} as unknown as TaskParams);
		expect(getFirstText(batch)).toContain("Task 1 (`Legacy`): The `isolated` field was removed:");
	});

	it("rejects the removed apply/merge fields with the definition-disposition migration error", async () => {
		mockDiscovery();
		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const flatResult = await flat.execute("tc-obsolete-apply", {
			task: "Work.",
			apply: true,
		} as unknown as TaskParams);
		expect(getFirstText(flatResult)).toContain("The `apply`/`merge` fields were removed:");
		expect(getFirstText(flatResult)).toContain("agent definition");

		const batched = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const batch = await batched.execute("tc-obsolete-merge", {
			context: "ctx",
			tasks: [{ name: "Legacy", task: "Work.", merge: "branch" }],
		} as unknown as TaskParams);
		expect(getFirstText(batch)).toContain("Task 1 (`Legacy`): The `apply`/`merge` fields were removed:");
	});

	it("exposes outputSchema but never the stale schema field", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(getSchemaProperties(flat).outputSchema).toBeDefined();
		expect(getSchemaProperties(flat).schema).toBeUndefined();

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		expect(getSchemaProperties(batch).schema).toBeUndefined();
	});
});

describe("task.batch validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

	it("rejects the stale schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", task: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("uses `outputSchema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ task: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", task: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level task in the batch shape", async () => {
		const text = await executeText({ task: "Work.", tasks: [{ task: "Other." }] }, { "task.batch": true });
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects empty task arrays and items without tasks", async () => {
		const empty = await executeText({ tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText({ tasks: [{ task: "Work." }, { name: "Beta" }] }, { "task.batch": true });
		expect(missing).toContain("Task 2 (`Beta`) is missing `task`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ tasks: [{ task: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided names case-insensitively", async () => {
		const text = await executeText(
			{
				tasks: [
					{ name: "Anna", task: "A." },
					{ name: "anna", task: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task name");
	});

	it("marks lenientArgValidation so execute() surfaces the actionable shape error", async () => {
		// Regression (#6039): the flat single-spawn wire schema rejects unknown
		// keys (`"+": "reject"`), so a batch `{ context, tasks[] }` payload fails
		// arktype validation in the agent loop — preempting the tool's own
		// actionable message. The lenient flag makes the loop forward the raw
		// args to execute() on that failure.
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(tool.lenientArgValidation).toBe(true);

		// The raw batch payload the loop would forward reaches execute() and
		// yields the actionable reason, never arktype's misleading missing-`task`.
		const text = await executeText(
			{ context: "Background.", tasks: [{ name: "Alpha", task: "Work." }] },
			{ "task.batch": false },
		);
		expect(text).toContain("task.batch is disabled");
		expect(text).not.toContain("was missing");
	});
});

describe("task.batch spawning", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawns one background job per task item and forwards independent models and schemas with shared context", async () => {
		mockDiscovery({
			...taskAgent,
			output: { type: "object", properties: { staleAgentOutput: { type: "boolean" } } },
		});
		const seen: Array<{
			id?: string;
			context?: string;
			assignment?: string;
			parentAgentId?: string;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaMode?: "permissive" | "strict";
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		mockIsolatedDispatch(options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, agentId: "ParentA", settings: { "async.enabled": true, "task.batch": true } }),
		);
		const alphaSchema = { type: "object", properties: { alpha: { type: "string" } } };
		const betaSchema = { type: "object", properties: { beta: { type: "number" } } };
		const result = await tool.execute("tc-batch", {
			context: "# Goal\nShared background.",
			tasks: [
				{
					name: "Alpha",
					task: "Do A.",
					outputSchema: alphaSchema,
					schemaMode: "strict",
				},
				{
					name: "Beta",
					task: "Do B.",
					outputSchema: betaSchema,
					schemaMode: "permissive",
				},
			],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain("Spawned 2 background agents");
		expect(text).toContain("- `Alpha`");
		expect(text).toContain("- `Beta`");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(result.details?.async?.state).toBe("running");

		const alphaJob = manager.getJob("Alpha");
		const betaJob = manager.getJob("Beta");
		expect(alphaJob).toBeDefined();
		expect(betaJob).toBeDefined();
		await alphaJob!.promise;
		await betaJob!.promise;

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
			expect(spawn.outputSchemaSource).toBe("caller");
			expect(spawn.outputSchemaOverridesAgent).toBe(true);
		}
		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		expect(byId.get("Alpha")?.outputSchema).toEqual(alphaSchema);
		expect(byId.get("Alpha")?.outputSchemaMode).toBe("strict");
		expect(byId.get("Beta")?.outputSchema).toEqual(betaSchema);
		expect(byId.get("Beta")?.outputSchemaMode).toBe("permissive");
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
	});

	it("routes each mixed-agent item through its selected definition while preserving caller overrides", async () => {
		const scoutSchema = { type: "object", properties: { findings: { type: "array" } } };
		const reviewerSchema = { type: "object", properties: { verdict: { type: "string" } } };
		const callerSchema = { type: "object", properties: { approved: { type: "boolean" } } };
		const scoutAgent: AgentDefinition = {
			...taskAgent,
			name: "scout",
			description: "Read-only scout",
			systemPrompt: "Investigate the assigned target.",
			tools: ["web_search"],
			model: ["anthropic/claude-haiku-4-5:low"],
			output: scoutSchema,
		};
		const reviewerAgent: AgentDefinition = {
			...taskAgent,
			name: "reviewer",
			description: "Code review specialist",
			systemPrompt: "Review the assigned target.",
			tools: ["web_search", "todo"],
			model: ["anthropic/claude-sonnet-4-6:medium"],
			output: reviewerSchema,
		};
		mockDiscovery([scoutAgent, reviewerAgent]);

		const seen: Array<{
			id?: string;
			agent: AgentDefinition;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		mockIsolatedDispatch(options => {
			seen.push({
				id: options.id,
				agent: options.agent,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?", { agent: options.agent.name });
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);
		const result = await tool.execute("tc-mixed-agents", {
			context: "Shared routing context.",
			tasks: [
				{ name: "Scout", agent: "scout", task: "Investigate." },
				{
					name: "Review",
					agent: "reviewer",
					task: "Review.",
					outputSchema: callerSchema,
				},
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned 2 background agents");
		await Promise.all([manager.getJob("Scout")!.promise, manager.getJob("Review")!.promise]);

		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		const scoutSpawn = byId.get("Scout");
		const reviewerSpawn = byId.get("Review");
		// The effective agent is resolved per spawn: identity/model/schema follow
		// the selected definition while the tool list becomes the common set
		// plus the definition's declared extras.
		expect(scoutSpawn?.agent.name).toBe("scout");
		expect(scoutSpawn?.agent.tools).toContain("web_search");
		expect(scoutSpawn?.agent.tools).not.toContain("todo");
		expect(scoutSpawn?.agent.tools).toEqual(expect.arrayContaining(["read", "write", "eval", "task", "hub"]));
		expect(scoutSpawn?.modelOverride).toEqual(["anthropic/claude-haiku-4-5:low"]);
		expect(scoutSpawn?.outputSchema).toBe(scoutSchema);
		expect(scoutSpawn?.outputSchemaSource).toBe("agent");
		expect(scoutSpawn?.outputSchemaOverridesAgent).toBe(false);
		expect(reviewerSpawn?.agent.name).toBe("reviewer");
		expect(reviewerSpawn?.agent.tools).toEqual(expect.arrayContaining(["web_search", "todo"]));
		expect(reviewerSpawn?.modelOverride).toEqual(["anthropic/claude-sonnet-4-6:medium"]);
		expect(reviewerSpawn?.outputSchema).toBe(callerSchema);
		expect(reviewerSpawn?.outputSchemaSource).toBe("caller");
		expect(reviewerSpawn?.outputSchemaOverridesAgent).toBe(true);
	});

	it("resolves each spawn's clone disposition from its agent definition", async () => {
		// `readOnly: false` on the definition merges; every other agent discards.
		// The wire carries no disposition field, so mixed batches mix
		// dispositions purely by agent choice.
		mockDiscovery([taskAgent, { ...taskAgent, name: "writer", readOnly: false }]);
		const dispositions: Record<string, "discard" | "merge" | undefined> = {};
		mockIsolatedDispatch(options => {
			dispositions[options.id ?? "?"] = options.cloneDisposition;
			return makeResult(options.id ?? "?");
		});
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "",
			changesApplied: null,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);
		const result = await tool.execute("tc-dispositions", {
			context: "Shared context.",
			tasks: [
				{ name: "Defaulted", task: "Do A." },
				{ name: "AlsoDefault", agent: "task", task: "Do B." },
				{ name: "Merged", agent: "writer", task: "Do C." },
			],
		} as TaskParams);
		expect(getFirstText(result)).toContain("Spawned 3 background agents");
		await Promise.all(["Defaulted", "AlsoDefault", "Merged"].map(id => manager.getJob(id)!.promise));

		expect(dispositions["Defaulted"]).toBe("discard");
		expect(dispositions["AlsoDefault"]).toBe("discard");
		expect(dispositions["Merged"]).toBe("merge");

		// The flat form resolves identically from the definition.
		const flat = await tool.execute("tc-flat-disposition", {
			agent: "writer",
			name: "FlatMerge",
			task: "Do D.",
		} as TaskParams);
		await manager.getJob(flat.details!.async!.jobId!)!.promise;
		expect(dispositions["FlatMerge"]).toBe("merge");
	});

	it("treats a one-item batch as a single spawn and forwards context", async () => {
		mockDiscovery();
		let capturedContext: string | undefined;
		mockIsolatedDispatch(options => {
			capturedContext = options.context;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-single", {
			context: "Shared notes.",
			tasks: [{ name: "Solo", task: "Do the thing." }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Solo`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(capturedContext).toBe("Shared notes.");
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery({
			...taskAgent,
			model: ["anthropic/claude-sonnet-4"],
			output: { type: "object", properties: { agent: { type: "string" } } },
		});
		let captured:
			| {
					modelOverride?: string | string[];
					outputSchema?: unknown;
					outputSchemaMode?: "permissive" | "strict";
					outputSchemaSource?: "caller" | "agent" | "session" | "none";
					outputSchemaOverridesAgent?: boolean;
			  }
			| undefined;
		mockIsolatedDispatch(options => {
			captured = {
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			};
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.agentModelOverrides": { task: "openai/gpt-4.1-mini" },
				},
			}),
		);

		const callerSchema = { type: "object", properties: { caller: { type: "number" } } };
		const result = await tool.execute("tc-flat", {
			agent: "task",
			name: "Flat",
			task: "Do the thing.",
			outputSchema: callerSchema,
			schemaMode: "strict",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(captured?.modelOverride).toEqual(["openai/gpt-4.1-mini"]);
		expect(captured?.outputSchema).toEqual(callerSchema);
		expect(captured?.outputSchemaMode).toBe("strict");
		expect(captured?.outputSchemaSource).toBe("caller");
		expect(captured?.outputSchemaOverridesAgent).toBe(true);
	});

	it("blocks batch execution when async.enabled is false even with a job manager", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string }> = [];
		mockIsolatedDispatch(options => {
			seen.push({ id: options.id, context: options.context, assignment: options.assignment });
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("tc-sync-batch", {
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ name: "Alpha", task: "Do A." },
				{ name: "Beta", task: "Do B." },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("All done.");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta"]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		expect(manager.getJob("Beta")).toBeUndefined();
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
		]);
	});

	it("keeps a long result inline when no readable output artifact exists", async () => {
		mockDiscovery();
		const fullOutput = `REPORT:${"x".repeat(6_000)}:END`;
		mockIsolatedDispatch(options =>
			makeResult(options.id ?? "?", {
				output: fullOutput,
				outputMeta: { lineCount: 1, charCount: fullOutput.length },
			}),
		);

		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const result = await tool.execute("tc-missing-artifact", {
			name: "MissingArtifact",
			task: "Return a long report.",
		} as TaskParams);
		const text = getFirstText(result);

		expect(text).not.toContain("agent://MissingArtifact");
		expect(text).toContain(":END");
	});

	it("settles the batch async aggregate when a queued spawn is cancelled mid-flight", async () => {
		mockDiscovery();
		const started: string[] = [];
		const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
		mockIsolatedDispatch(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.set(id, { promise, resolve });
			await promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 },
			}),
		);

		const updates: Array<{ async?: { state?: string }; progress?: Array<{ id: string; status: string }> }> = [];
		const result = await tool.execute(
			"tc-batch-cancel",
			{
				context: "ctx",
				tasks: [
					{ name: "First", task: "Do A." },
					{ name: "Second", task: "Do B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						async: update.details.async,
						progress: update.details.progress?.map(p => ({ id: p.id, status: p.status })),
					});
				}
			},
		);

		expect(result.details?.async?.state).toBe("running");

		const firstJob = manager.getJob("First")!;
		const secondJob = manager.getJob("Second")!;
		const deadline = Date.now() + 1_000;
		while (started.length === 0) {
			if (Date.now() > deadline) throw new Error("First spawn never reached the executor");
			await Bun.sleep(5);
		}
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;

		gates.get("First")!.resolve();
		await firstJob.promise;

		expect(secondJob.status).toBe("cancelled");
		const last = updates.at(-1);
		// The acquire-time abort path has to flow through the same `onSettled`
		// the post-acquire abort path uses, otherwise the batch aggregate sticks
		// at "running" forever after the surviving spawn completes.
		expect(last?.async?.state).toBe("failed");
		expect(last?.progress?.find(p => p.id === "Second")?.status).toBe("aborted");
		expect(last?.progress?.find(p => p.id === "First")?.status).toBe("completed");
	});
});
