import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { stubCloneSeam } from "../helpers/clone-seam";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const mutableTaskAgent: AgentDefinition = { ...taskAgent, mutable: true };

function createSession(options: {
	manager: AsyncJobManager;
	settings?: Record<string, unknown>;
	spawns?: string | boolean;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, ...options.settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

describe("task async preflight", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function manager(): AsyncJobManager {
		const result = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(result);
		return result;
	}

	it.each([
		{
			name: "Unknown",
			params: { agent: "missing", name: "Unknown", task: "Work." },
			expectation: 'Unknown agent "missing"',
		},
		{
			name: "Disabled",
			params: { agent: "task", name: "Disabled", task: "Work." },
			settings: { "task.disabledAgents": ["task"] },
			expectation: 'Agent "task" is disabled',
		},
		{
			name: "Disallowed",
			params: { agent: "task", name: "Disallowed", task: "Work." },
			spawns: "scout",
			expectation: "Cannot spawn 'task'",
		},
	])(
		"returns $name policy errors before registering an async job",
		async ({ name, params, settings, spawns, expectation }) => {
			mockDiscovery();
			const jobs = manager();
			const tool = await TaskTool.create(createSession({ manager: jobs, settings, spawns }));

			const result = await tool.execute("preflight", params as TaskParams);

			expect(textOf(result)).toContain(expectation);
			expect(jobs.getJob(name)).toBeUndefined();
		},
	);

	it("rejects an invalid async batch atomically before dispatching any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(createSession({ manager: jobs, settings: { "task.batch": true } }));

		const result = await tool.execute("mixed-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "AlsoInvalid", agent: "also-missing", task: "Do more invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		const text = textOf(result);
		expect(text).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(text).toContain('Task AlsoInvalid failed preflight: Unknown agent "also-missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("AlsoInvalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("rejects an invalid synchronous batch before running any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(
			createSession({ manager: jobs, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("sync-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		expect(textOf(result)).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});
});

describe("task disposition pinning", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function manager(): AsyncJobManager {
		const result = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(result);
		return result;
	}

	/**
	 * Two-item batch behind a concurrency-1 semaphore: both items preflight
	 * with the current definition, then the definition is swapped while First
	 * is gated in the executor, so Second's launch re-resolves the changed
	 * ceiling against its pinned disposition.
	 */
	async function runPinnedBatch(options: {
		preflightAgent: AgentDefinition;
		launchAgent: AgentDefinition;
	}): Promise<{ first: AsyncJob; second: AsyncJob; isolatedCalls: Array<{ discard: boolean }> }> {
		const discover = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [options.preflightAgent], projectAgentsDir: null });
		// Ordinary spawns always clone: stub the seam so runs reach the
		// (separately mocked) executor; the per-test runner stub below records
		// each launch's pinned disposition.
		stubCloneSeam({ repoRoot: "/tmp" });
		const gate = Promise.withResolvers<void>();
		const firstStarted = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			firstStarted.resolve();
			await gate.promise;
			return resultFor(options.id);
		});
		const isolatedCalls: Array<{ discard: boolean }> = [];
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts => {
			isolatedCalls.push({ discard: opts.discard });
			const result = await executorModule.runSubprocess(opts.baseOptions);
			return { ...result, isolated: true };
		});

		const jobs = manager();
		const tool = await TaskTool.create(
			createSession({
				manager: jobs,
				settings: { "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 },
			}),
		);
		const result = await tool.execute("pinning", {
			context: "ctx",
			tasks: [
				{ name: "First", task: "Work A." },
				{ name: "Second", task: "Work B." },
			],
		} as TaskParams);
		const first = jobs.getJob("First");
		const second = jobs.getJob("Second");
		if (!first || !second) throw new Error(`Expected both jobs to register: ${textOf(result)}`);

		// First is gated mid-dispatch; swap the definition before Second launches.
		await firstStarted.promise;
		discover.mockResolvedValue({ agents: [options.launchAgent], projectAgentsDir: null });
		gate.resolve();
		await first.promise;
		await second.promise.catch(() => {});
		return { first, second, isolatedCalls };
	}

	it("rejects a merge-pinned launch when the definition tightens after preflight", async () => {
		const { first, second, isolatedCalls } = await runPinnedBatch({
			preflightAgent: mutableTaskAgent,
			launchAgent: taskAgent,
		});

		expect(first.status).toBe("completed");
		expect(second.status).toBe("failed");
		expect(second.errorText ?? second.resultText ?? "").toContain('Agent "task" does not permit mutable execution');
		expect(isolatedCalls).toHaveLength(1);
	});

	it("keeps a discard-pinned launch when the definition loosens after preflight", async () => {
		const { first, second, isolatedCalls } = await runPinnedBatch({
			preflightAgent: taskAgent,
			launchAgent: mutableTaskAgent,
		});

		expect(first.status).toBe("completed");
		expect(second.status).toBe("completed");
		// Loosening never promotes a pinned discard to a merge.
		expect(isolatedCalls).toEqual([{ discard: true }, { discard: true }]);
	});
});
