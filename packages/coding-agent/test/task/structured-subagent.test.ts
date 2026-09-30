import { $ } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BeforeSubagentSpawnEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
	COMMON_SUBAGENT_TOOL_NAMES,
	OBSOLETE_SUBAGENT_CONTROL_MESSAGE,
} from "@oh-my-pi/pi-coding-agent/task/tool-policy";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { stubCloneSeam } from "../helpers/clone-seam";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		cwd?: string;
		settings?: Settings;
		planMode?: boolean;
		outputSchema?: unknown;
		maxDepth?: number;
		modelRoles?: Record<string, string>;
		agentServiceTierOverrides?: Record<string, string>;
	} = {},
): ToolSession {
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings:
			options.settings ??
			Settings.isolated({
				"task.maxRecursionDepth": options.maxDepth ?? 2,
				"isolation.backend": "rcopy",
				"task.enableLsp": true,
				...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
				...(options.agentServiceTierOverrides
					? { "task.agentServiceTierOverrides": options.agentServiceTierOverrides }
					: {}),
			}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	// Ordinary execution always clones; tests that are not about Git probing
	// stub the probe instead of creating a real repository.
	vi.spyOn(isolationRunner, "probeIsolationRepoRoot").mockResolvedValue({ repoRoot: "/tmp" });
}

/**
 * Route an ordinary clone dispatch into a test double: the clone seam is
 * stubbed and the isolated runner delegates to the executor options directly,
 * so assertions see the same ExecutorOptions a real child run would receive.
 */
function mockCloneDispatch(
	impl: (baseOptions: executorModule.ExecutorOptions) => Promise<SingleResult> | SingleResult,
): void {
	stubCloneSeam({ repoRoot: "/tmp" });
	vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => impl(baseOptions));
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("resolves user-tagged model agents for task and eval but rejects untagged names", async () => {
		mockDiscovery();
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		for (const invocationKind of ["task", "eval"] satisfies StructuredSubagentRequest["invocationKind"][]) {
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: taggedSession, agent: "m1", invocationKind }),
			);
			expect(policy.agent.name).toBe("m1");
			expect(policy.modelOverride).toEqual(["a/x"]);
		}
		await expect(resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m9" }))).rejects.toThrow(
			'Unknown agent "m9". Available: worker, m1',
		);
	});

	it("keeps discovered agents authoritative on pseudonym collisions", async () => {
		mockDiscovery({ ...AGENT, name: "m1", model: ["b/y"] });
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		const policy = await resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m1" }));
		expect(policy.modelOverride).toEqual(["b/y"]);
	});

	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable true before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.execution).toEqual({ kind: "plan" });
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		// Plan mode accepts omitted/false mutable and stays a non-clone execution.
		const narrowed = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), mutable: false }),
		);
		expect(narrowed.execution).toEqual({ kind: "plan" });

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: session({ planMode: true }), mutable: true })),
		).rejects.toThrow("Mutable subagent execution is unavailable in plan mode.");

		// Removed isolation request controls reject everywhere, plan mode included.
		const obsoleteRequest = request({ session: session({ planMode: true }) });
		(obsoleteRequest as unknown as Record<string, unknown>).isolation = { requested: false };
		await expect(resolveEffectiveSubagentPolicy(obsoleteRequest)).rejects.toThrow(OBSOLETE_SUBAGENT_CONTROL_MESSAGE);

		const planSession = session({ planMode: true });
		const customTools = createEvalCustomTools(planSession, [
			{
				name: "word_count",
				description: "Count words",
				parameters: { type: "object", properties: {} },
				language: "python",
			},
		]);
		await expect(resolveEffectiveSubagentPolicy(request({ session: planSession, customTools }))).rejects.toThrow(
			"Eval-defined tools are unavailable in plan mode.",
		);
		expect(discover).not.toHaveBeenCalled();
	});
	it("clones discovered agents by default and lets mutable definitions opt into apply-back", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clone-policy-"));
		try {
			await $`git init -q ${repo}`.quiet();
			const original = { ...AGENT, name: "reviewer" };
			const applying = { ...AGENT, name: "m1", mutable: true };
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [original, applying],
				projectAgentsDir: null,
			});
			const enabled = session({ cwd: repo });
			const discarded = await resolveEffectiveSubagentPolicy(request({ session: enabled, agent: "reviewer" }));
			expect(discarded.execution).toEqual({ kind: "clone", disposition: "discard", mergeMode: "patch" });
			const retained = await resolveEffectiveSubagentPolicy(request({ session: enabled, agent: "m1" }));
			expect(retained.execution).toEqual({ kind: "clone", disposition: "merge", mergeMode: "patch" });
			const narrowed = await resolveEffectiveSubagentPolicy(
				request({ session: enabled, agent: "m1", mutable: false }),
			);
			expect(narrowed.execution).toEqual({ kind: "clone", disposition: "discard", mergeMode: "patch" });
			// The definition ceiling is hard: a caller can narrow, never widen.
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: enabled, agent: "reviewer", mutable: true })),
			).rejects.toThrow('Agent "reviewer" does not permit mutable execution; omit mutable or pass mutable: false.');
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: enabled, agent: "m1", mutable: true })),
			).resolves.toMatchObject({ execution: { kind: "clone", disposition: "merge" } });
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	it("rejects ordinary execution outside a Git checkout instead of running directly", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...AGENT, name: "reviewer" }],
			projectAgentsDir: null,
		});
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nongit-agent-"));
		try {
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: session({ cwd }), agent: "reviewer" })),
			).rejects.toThrow(
				"Subagent execution requires an isolated clone, but this workspace cannot provide one: Git repository not found",
			);
			await expect(runStructuredSubagent(request({ session: session({ cwd }), agent: "reviewer" }))).rejects.toThrow(
				"Subagent execution requires an isolated clone",
			);
			// Plan-mode runs stay in-place and never need a clone.
			const plan = await resolveEffectiveSubagentPolicy(
				request({ session: session({ cwd, planMode: true }), agent: "reviewer" }),
			);
			expect(plan.execution).toEqual({ kind: "plan" });
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("reloads project task and retry policy before resolving an agent added during the session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-hot-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"task:\n  enableEffort: true\nretry:\n  modelFallback: true\n",
		);
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = {
			...session(),
			cwd: projectDir,
			settings: liveSettings,
		} as ToolSession;
		vi.spyOn(isolationRunner, "probeIsolationRepoRoot").mockResolvedValue({ repoRoot: projectDir });

		try {
			await Bun.write(
				path.join(projectDir, ".omp", "config.yml"),
				"task:\n  agentModelOverrides:\n    hot-worker: xai-oauth/grok-4.6:medium\n  enableEffort: false\nretry:\n  modelFallback: false\n",
			);
			await Bun.write(
				path.join(projectDir, ".omp", "agents", "hot-worker.md"),
				"---\nname: hot-worker\ndescription: Newly added worker.\nmodel: openai/gpt-4o\n---\n\nInspect the assignment.\n",
			);

			const policy = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "hot-worker" }));

			expect(policy.modelOverride).toEqual(["xai-oauth/grok-4.6:medium"]);
			expect(liveSettings.get("task.enableEffort")).toBe(false);
			expect(liveSettings.get("retry.modelFallback")).toBe(false);
		} finally {
			liveSettings.cancelPendingSaves();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves only the exact case-sensitive service-tier override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });

		const exact = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { scout: "priority" } }), agent: "scout" }),
		);
		expect(exact.serviceTierOverride).toBe("priority");

		const differentCase = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { Scout: "priority" } }), agent: "scout" }),
		);
		expect(differentCase.serviceTierOverride).toBeUndefined();
	});

	it("reloads persisted per-agent service-tier overrides before each launch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-tier-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = session({ cwd: projectDir, settings: liveSettings });
		mockDiscovery({ ...AGENT, name: "scout" });
		const configPath = path.join(agentDir, "config.yml");

		try {
			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: priority\n");
			const first = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(first.serviceTierOverride).toBe("priority");

			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: none\n");
			const second = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(second.serviceTierOverride).toBe("none");
		} finally {
			liveSettings.cancelPendingSaves();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		mockCloneDispatch(options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("does not treat a spawn handle as the HUD description", async () => {
		mockDiscovery();
		const dispatched: executorModule.ExecutorOptions[] = [];
		mockCloneDispatch(options => {
			dispatched.push(options);
			return result();
		});

		const handleOnly = await runStructuredSubagent(
			request({ identity: { id: "AuthLoader", label: "AuthLoader" }, retainArtifacts: true }),
		);
		expect(dispatched[0]?.description).toBeUndefined();
		expect(dispatched[0]?.id).toBe("AuthLoader");
		await fs.rm(handleOnly.artifactsDir, { recursive: true, force: true });

		dispatched.length = 0;
		const evalLabeled = await runStructuredSubagent(
			request({
				invocationKind: "eval",
				identity: { label: "Refactor the auth flow" },
				retainArtifacts: true,
			}),
		);
		expect(dispatched[0]?.description).toBe("Refactor the auth flow");
		await fs.rm(evalLabeled.artifactsDir, { recursive: true, force: true });
	});

	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		roleSession.settings.override("task.agentModelOverrides", { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, model: "@request" }));
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		concreteOverrideSession.settings.override("task.agentModelOverrides", { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty request selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("lets before_subagent_spawn replace model patterns at dispatch without dropping role identity", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = session({ modelRoles: { definition: "anthropic/claude-opus-4-5" } });
		const events: BeforeSubagentSpawnEvent[] = [];
		childSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
			return { model: "openai/gpt-4o", note: "pool test" };
		};
		const dispatched: executorModule.ExecutorOptions[] = [];
		mockCloneDispatch(options => {
			dispatched.push(options);
			return result();
		});

		// Frontend preflight is side-effect free: stateful routers must not advance.
		await resolveEffectiveSubagentPolicy(request({ session: childSession }));
		expect(events).toEqual([]);

		const settled = await runStructuredSubagent(request({ session: childSession, retainArtifacts: true }));
		expect(dispatched[0]).toMatchObject({
			modelOverride: ["openai/gpt-4o"],
			modelRole: "definition",
			modelRoute: "pool test",
		});
		expect(events).toEqual([
			{
				type: "before_subagent_spawn",
				agent: "worker",
				invocationKind: "task",
				modelRole: "definition",
				patterns: ["anthropic/claude-opus-4-5"],
			},
		]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("rejects dispatch before leasing artifacts when an extension blocks the spawn", async () => {
		mockDiscovery();
		const blockedSession = session();
		blockedSession.emitBeforeSubagentSpawn = async () => ({ block: true, reason: "pool exhausted" });
		const run = vi.spyOn(executorModule, "runSubprocess");
		const isolatedRun = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		const error = await runStructuredSubagent(request({ session: blockedSession })).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect(error as StructuredSubagentError).toMatchObject({ kind: "preflight", message: "pool exhausted" });
		expect(run).not.toHaveBeenCalled();
		expect(isolatedRun).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		mockCloneDispatch(options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		mockCloneDispatch(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains temporary artifacts when the run failed but yielded schema-valid structured output", async () => {
		// Regression: a task can produce schema-valid data and then fail (or
		// exceed its runtime limit). The async notice still advertises the
		// full payload at `agent://<id>` for schema-valid output, so
		// retention must not require `exitCode === 0` too — otherwise the
		// directory is already gone by the time the model follows that URL
		// (PR #10625 review).
		mockDiscovery();
		mockCloneDispatch(() => ({
			...result(),
			exitCode: 1,
			error: "runtime limit exceeded",
			structuredOutput: { source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
		}));

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("valid");
		await expect(fs.stat(settled.artifactsDir)).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		const isolatedDispatch = vi.spyOn(isolationRunner, "runIsolatedSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
		expect(isolatedDispatch).not.toHaveBeenCalled();
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		mockCloneDispatch(() => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("names the failure when nested patches cannot be written as a fallback", async () => {
		// `Bun.write` creates missing parents, so a genuine failure needs a path
		// that cannot become a directory: a regular file in its place.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-unwritable-"));
		const artifactsDir = path.join(parent, "artifacts");
		await fs.writeFile(artifactsDir, "");
		const completed = result();
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);

		expect(hint).toMatch(/Nested patches could not be written: .*(ENOTDIR|EEXIST)/);
		expect(hint).not.toContain("Captured nested patch preserved");
		await fs.rm(parent, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when clone setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(runStructuredSubagent(request())).rejects.toThrow(
			"Isolated subagent execution could not be prepared: not a repository",
		);
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		mockCloneDispatch(options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses ambient capabilities on every execution kind while preserving host propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const preparedExtensions = [
			{
				path: extensionPaths[0]!,
				resolvedPath: extensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		] as NonNullable<ToolSession["preparedExtensions"]>;
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const cloneSession = session();
		let explicitRoot = "/plugins/explicit";
		const extensionRoots = () => ({
			explicit: [explicitRoot],
			mode: "explicit-only" as const,
			configured: ["/plugins/configured"],
			configuredLevel: "project" as const,
		});
		Object.assign(cloneSession, {
			mcpManager,
			extensionPaths,
			customToolPaths,
			preparedExtensions,
			effectiveExtensionRoots: extensionRoots,
			getEvalSessionId: () => "parent-eval-kernel",
		});
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});
		mockCloneDispatch(baseOptions => {
			options.push(baseOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const cloneRun = await runStructuredSubagent(request({ session: cloneSession, retainArtifacts: true }));
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		// Plan execution runs directly with its attenuated tool set.
		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		// Ordinary clones never inherit ambient MCP, extension, or custom-tool
		// sources, and they own their eval kernel rather than sharing the parent's.
		expect(options[1]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedPreparedExtensions: preparedExtensions,
			preloadedCustomToolPaths: [],
			cloneDisposition: "discard",
		});
		expect(options[1]?.mcpManager).toBeUndefined();
		expect(options[1]?.parentEvalSessionId).toBeUndefined();
		expect(options[1]?.extensionRoots?.()).toEqual(extensionRoots());
		explicitRoot = "/plugins/explicit-after-spawn";
		expect(options[1]?.extensionRoots?.().explicit).toEqual([explicitRoot]);
		expect(options[2]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[2]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(cloneRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("gates ambient capabilities while granting the common coding toolset", async () => {
		const specialist = getBundledAgent("conventions-specialist");
		if (!specialist) throw new Error("Missing bundled conventions specialist");
		mockDiscovery(specialist);
		const host = session();
		Object.assign(host, {
			mcpManager: {} as NonNullable<ToolSession["mcpManager"]>,
			extensionPaths: ["/plugins/unsafe.ts"],
			customToolPaths: [{ path: "/tools/unsafe.ts", source: "project" }] as unknown as NonNullable<
				ToolSession["customToolPaths"]
			>,
		});
		const options: executorModule.ExecutorOptions[] = [];
		mockCloneDispatch(baseOptions => {
			options.push(baseOptions);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: host, agent: specialist.name, retainArtifacts: true }),
		);
		expect(options[0]).toMatchObject({
			restrictToolNames: true,
			enableMCP: false,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		// A report-only specialist still receives the shared scratch-clone
		// toolset; its role constraint, not the tool list, keeps it read-only.
		expect(options[0]?.agent.tools).toEqual([...COMMON_SUBAGENT_TOOL_NAMES]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps explicit memory readers on the backend-initializing path", async () => {
		const reader = { ...AGENT, name: "memory-reader", tools: ["read", "recall", "yield"] };
		mockDiscovery(reader);
		const options: executorModule.ExecutorOptions[] = [];
		mockCloneDispatch(baseOptions => {
			options.push(baseOptions);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({
				session: session({ settings: Settings.isolated({ "memory.backend": "mnemopi" }) }),
				agent: reader.name,
				retainArtifacts: true,
			}),
		);
		expect(options[0]?.restrictToolNames).toBe(true);
		expect(options[0]?.agent.tools).toContain("recall");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed clone handle artifacts without recovery payloads", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		mockCloneDispatch(options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("reports a run that failed before yielding as unavailable, not schema-invalid", async () => {
		// Production 2026-09-21: a scout whose model stream died mid-prose
		// ("Anthropic stream envelope error: stream ended before message_stop")
		// was delivered as `Structured output: schema invalid: <provider error>`
		// with its half-streamed text as the offending payload. No payload was
		// ever validated, so the status is "unavailable", the error is the
		// provider's, and the partial prose is not presented as data.
		mockDiscovery();
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		mockCloneDispatch(() => ({
			...result(),
			exitCode: 1,
			output: "I'll systematically investigate the codebase",
			stderr: error,
			error,
		}));

		const settled = await runStructuredSubagent(request());

		expect(settled.result.structuredOutput).toEqual({
			source: "agent",
			mode: "permissive",
			status: "unavailable",
			error,
		});
		expect(settled.result.structuredOutput).not.toHaveProperty("data");
	});

	it("retains a detached task's artifacts on failure even without valid structured output", async () => {
		// Regression: a detached (async) task job that fails without a valid
		// structured payload previously had its temp dir wiped immediately,
		// breaking the "failed agent stays interrogable" invariant
		// (task/index.ts) — the model could no longer read the failure via
		// agent://<id> or history://<id> (PR #10625 review).
		mockDiscovery();
		let artifactsDir: string | undefined;
		mockCloneDispatch(options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true, detached: true }));

		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("unavailable");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		await expect(fs.stat(artifactsDir ?? "")).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("returns a discard clone's report without capturing or retaining changes", async () => {
		mockDiscovery({ ...AGENT, name: "reviewer" });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
			baseline: null,
		} as unknown as isolationRunner.IsolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockResolvedValue({
			...result(),
			agent: "reviewer",
			isolated: true,
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(request({ agent: "reviewer" }));

		expect(merge).not.toHaveBeenCalled();
		expect(settled.mergeSummary).toContain("Isolation: ran in a discarded worktree; file changes were not kept");
		expect(settled.changesApplied).toBeNull();
		expect(settled.result.cloneDisposition).toBe("discard");
		expect(settled.result.changesApplied).toBeNull();
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(settled.artifactsDir)).rejects.toThrow();
	});

	it("retains clone failure artifacts needed for recovery", async () => {
		// A merge-disposition run captures patches on failure; a discard run
		// never captures, so recovery retention only applies here.
		mockDiscovery({ ...AGENT, mutable: true });
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
		} as unknown as isolationRunner.IsolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(request());

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("names the preserved branch when nested persistence fails after a branch commit", async () => {
		mockDiscovery({ ...AGENT, mutable: true });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
		} as unknown as isolationRunner.IsolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async () => ({
			...result(),
			branchName: "omp/task/Worker",
			branchBaseSha: "base",
			nestedPatches: [{ relativePath: "inner", patch: "diff --git a/b.txt b/b.txt\n" }],
			error: "Nested patch capture failed: ENOSPC. Isolation workspace retained at /wt/abc.",
		}));

		const settled = await runStructuredSubagent(request());

		expect(settled.result.cloneDisposition).toBe("merge");
		expect(settled.mergeSummary).toContain("omp/task/Worker");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("resolves the clone disposition from the definition ceiling and per-call narrowing", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(request());
		expect(defaultPolicy.execution).toEqual({ kind: "clone", disposition: "discard", mergeMode: "patch" });

		const narrowed = await resolveEffectiveSubagentPolicy(request({ mutable: false }));
		expect(narrowed.execution).toEqual({ kind: "clone", disposition: "discard", mergeMode: "patch" });

		await expect(resolveEffectiveSubagentPolicy(request({ mutable: true }))).rejects.toThrow(
			'Agent "worker" does not permit mutable execution; omit mutable or pass mutable: false.',
		);

		mockDiscovery({ ...AGENT, mutable: true });
		const mergeByDefault = await resolveEffectiveSubagentPolicy(request());
		expect(mergeByDefault.execution).toEqual({ kind: "clone", disposition: "merge", mergeMode: "patch" });

		const branchMode = await resolveEffectiveSubagentPolicy(
			request({ session: session({ settings: Settings.isolated({ "task.isolation.merge": "branch" }) }) }),
		);
		expect(branchMode.execution).toEqual({ kind: "clone", disposition: "merge", mergeMode: "branch" });

		// Task and eval invocations resolve identically.
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval", mutable: true }));
		expect(evalPolicy.execution).toEqual({ kind: "clone", disposition: "merge", mergeMode: "patch" });
	});

	it("rejects malformed mutable values and removed isolation controls before dispatch", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(isolationRunner, "runIsolatedSubprocess");

		await expect(resolveEffectiveSubagentPolicy(request({ mutable: "yes" as never }))).rejects.toThrow(
			"`mutable` must be a boolean.",
		);
		for (const key of ["isolated", "apply", "merge", "readOnly", "isolation"] as const) {
			for (const value of [true, false, null, undefined]) {
				const stale = request();
				(stale as unknown as Record<string, unknown>)[key] = value;
				await expect(resolveEffectiveSubagentPolicy(stale)).rejects.toThrow(OBSOLETE_SUBAGENT_CONTROL_MESSAGE);
			}
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("resolves host-managed execution and refuses a mutable argument for it", async () => {
		mockDiscovery();
		const managedSession = session();
		managedSession.managedSubagentExecution = { toolNames: ["read", "grep"], spawns: [] };

		const policy = await resolveEffectiveSubagentPolicy(request({ session: managedSession }));
		expect(policy.execution).toEqual({ kind: "managed", contract: { toolNames: ["read", "grep"], spawns: [] } });
		// An explicit empty spawn list erases the definition's authority.
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep"]);

		await expect(
			resolveEffectiveSubagentPolicy(request({ session: managedSession, mutable: false })),
		).rejects.toThrow("mutable applies only to ordinary cloned subagents.");
	});

	it("grants the common coding toolset and rejects MCP or unknown definition extras", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(request());
		expect(policy.effectiveAgent.tools).toEqual([...COMMON_SUBAGENT_TOOL_NAMES]);

		mockDiscovery({ ...AGENT, tools: ["web_search"] });
		const withExtra = await resolveEffectiveSubagentPolicy(request());
		expect(withExtra.effectiveAgent.tools).toEqual([...COMMON_SUBAGENT_TOOL_NAMES, "web_search"]);

		mockDiscovery({ ...AGENT, tools: ["mcp__server__search"] });
		await expect(resolveEffectiveSubagentPolicy(request())).rejects.toThrow(
			'Agent "worker" declares MCP tool "mcp__server__search" in tools; MCP tools are not available to subagents.',
		);

		mockDiscovery({ ...AGENT, tools: ["definitely_not_a_tool"] });
		await expect(resolveEffectiveSubagentPolicy(request())).rejects.toThrow(
			'Agent "worker" declares unknown tool "definitely_not_a_tool" in tools; extras must be built-in tool names.',
		);
	});

	it("integrates a successful merge run and reports the applied outcome", async () => {
		mockDiscovery({ ...AGENT, mutable: true });
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
		} as unknown as isolationRunner.IsolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nApplied 1 file.",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});
		vi.spyOn(isolationRunner, "applyEligibleNestedPatches").mockResolvedValue("");

		const settled = await runStructuredSubagent(request());

		expect(merge).toHaveBeenCalledTimes(1);
		expect(settled.changesApplied).toBe(true);
		expect(settled.mergeSummary).toContain("Applied 1 file.");
		expect(settled.result.cloneDisposition).toBe("merge");
		expect(settled.result.changesApplied).toBe(true);
		// A clean merge needs no recovery artifacts.
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("retains recovery artifacts when a merge run cannot apply its changes", async () => {
		mockDiscovery({ ...AGENT, mutable: true });
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
		} as unknown as isolationRunner.IsolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\n<system-notification>Patch apply failed: conflict.</system-notification>",
			changesApplied: false,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});

		const settled = await runStructuredSubagent(request());

		expect(settled.changesApplied).toBe(false);
		expect(settled.mergeSummary).toContain("Patch apply failed");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});

describe("nested clone beneath a discard parent", () => {
	// Real Git fixture, real isolation runner: only the leaf executor is
	// doubled. A mutable child spawned inside a discard parent's clone merges
	// into that clone; the discarded parent never forwards it to the outer
	// checkout.
	it("merges a mutable child into the parent's discarded clone without touching the outer checkout", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nested-discard-"));
		try {
			await $`git init -q -b main`.cwd(repoRoot);
			await $`git config user.email repro@example.com`.cwd(repoRoot);
			await $`git config user.name Repro`.cwd(repoRoot);
			await Bun.write(path.join(repoRoot, "parent.txt"), "parent\n");
			await $`git add parent.txt`.cwd(repoRoot);
			await $`git commit -q -m seed`.cwd(repoRoot);

			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [{ ...AGENT, mutable: true }],
				projectAgentsDir: null,
			});
			const childBytes = "child wrote this\n";
			const runCalls: string[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const worktree = options.worktree ?? options.cwd;
				runCalls.push(worktree);
				if (runCalls.length === 1) {
					// Parent run, inside the parent's own clone: spawn the mutable
					// child against the clone as its checkout.
					const nested = await runStructuredSubagent(
						request({ session: session({ cwd: worktree }), mutable: true }),
					);
					expect(nested.result.exitCode).toBe(0);
					expect(nested.result.cloneDisposition).toBe("merge");
					// The child's merge landed in the parent's clone.
					expect(await Bun.file(path.join(worktree, "child.txt")).text()).toBe(childBytes);
					return { ...result(), id: options.id ?? "Parent" };
				}
				// Child run, inside the child's clone: write exact bytes.
				await Bun.write(path.join(worktree, "child.txt"), childBytes);
				return { ...result(), id: options.id ?? "Child" };
			});

			const settled = await runStructuredSubagent(request({ session: session({ cwd: repoRoot }), mutable: false }));

			expect(settled.result.exitCode).toBe(0);
			expect(settled.result.cloneDisposition).toBe("discard");
			expect(runCalls).toHaveLength(2);
			// The outer checkout is byte-identical: the discarded parent clone
			// never forwarded the nested merge.
			expect(await $`git status --porcelain=v1`.cwd(repoRoot).text()).toBe("");
			expect(await Bun.file(path.join(repoRoot, "parent.txt")).text()).toBe("parent\n");
			expect(await Bun.file(path.join(repoRoot, "child.txt")).exists()).toBe(false);
		} finally {
			await fs.rm(repoRoot, { recursive: true, force: true });
		}
	});
});
