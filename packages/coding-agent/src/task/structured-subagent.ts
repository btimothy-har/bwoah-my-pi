/**
 * Shared policy resolution and execution for task and eval subagents.
 *
 * The two public frontends deliberately retain their presentation concerns, but
 * every decision that affects what a child may run lives here.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { $env, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { resolveAgentModelSelection, resolveConfiguredModelPatterns } from "../config/model-resolver";
import {
	type CompactionThresholdPair,
	validateAgentCompactionThresholdOverrides,
} from "../config/compaction-threshold";
import { type ServiceTierInheritSettingValue, validateAgentServiceTierOverrides } from "../config/service-tier";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { sessionLocalProtocolOptions } from "../internal-urls/context";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import isolationRecoveryHintTemplate from "../prompts/tools/isolation-recovery-hint.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import salvagedChildHintTemplate from "../prompts/tools/salvaged-child-hint.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import type { ToolSession } from "../tools";
import { normalizeToolNames } from "../tools/builtin-names";
import { isIrcEnabled } from "../irc/messaging";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { trackLateCleanup } from "../utils/late-cleanup";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { type ExecutorOptions, runSubprocess } from "./executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	persistNestedPatches,
	prepareIsolationContext,
	probeIsolationRepoRoot,
	renderIsolationSummary,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { isReadOnlyAgent } from "./read-only-policy";
import { resolveSpawnPolicy } from "./spawn-policy";
import {
	hasObsoleteSubagentControl,
	OBSOLETE_SUBAGENT_CONTROL_MESSAGE,
	resolveSubagentToolNames,
	SubagentToolPolicyError,
} from "./tool-policy";
import { type AgentDefinition, canSpawnAtDepth, type ManagedSubagentExecution } from "./types";
import type {
	AgentProgress,
	SingleResult,
	StructuredSubagentOutput,
	StructuredSubagentSchemaMode,
	StructuredSubagentSchemaSource,
	SubagentCloneDisposition,
} from "@oh-my-pi/pi-tui/tools/task";
import type { WorkPoolYieldItem } from "./workpool-yield";
import { parseIsolationBackend } from "./worktree";

import {
	cfgIsolationBackend,
	cfgTaskAgentCompactionThresholdOverrides,
	cfgTaskAgentModelOverrides,
	cfgTaskAgentServiceTierOverrides,
	cfgTaskDisabledAgents,
	cfgTaskEnableLsp,
	cfgTaskIsolationMerge,
	cfgTaskMaxRecursionDepth,
} from "./settings";

/** Final structured completion metadata returned for a schema-bearing run. */
export type StructuredSubagentSchemaResult = StructuredSubagentOutput;

/** A schema validation or extraction error attached to structured completion metadata. */
export type StructuredSubagentSchemaError = NonNullable<StructuredSubagentOutput["error"]>;

/** A selected schema paired with its source and enforcement mode. */
export interface StructuredSubagentSchemaResolution {
	schema: unknown;
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	outputSchemaOverridesAgent: boolean;
}

/** How a validated subagent run executes once dispatched. */
export type SubagentExecutionPolicy =
	| { kind: "clone"; disposition: SubagentCloneDisposition; mergeMode: "patch" | "branch" }
	| { kind: "managed"; contract: ManagedSubagentExecution }
	| { kind: "plan" };

/** Identity and presentation metadata supplied by the calling surface. */
export interface StructuredSubagentIdentity {
	/** A previously reserved output/registry id. */
	id?: string;
	/** Stable user-facing label used when allocating a new id. */
	label?: string;
}

/** One normalized child invocation. */
export interface StructuredSubagentRequest {
	session: ToolSession;
	invocationKind: "task" | "eval";
	assignment: string;
	context?: string;
	agent?: string;
	model?: string | string[];
	/** Presence, rather than truthiness, makes this the highest-priority schema. */
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	/** Per-spawn thinking effort mapped onto the resolved model's supported range; overrides the agent's default selector. */
	effort?: TaskEffort;
	/** Caller's description of how open-ended the work is; steers the child's `auto` thinking classification. */
	solutionSpace?: string;
	identity?: StructuredSubagentIdentity;
	index?: number;
	parentToolCallId?: string;
	detached?: boolean;
	invokedAt?: number;
	acquiredAt?: number;
	/**
	 * Requested clone disposition: `true` asks for apply-back (merge), `false`
	 * asks to discard. Omitted resolves to the definition's `mutable` ceiling.
	 * Never exceeds that ceiling; host-managed and plan-mode runs reject it.
	 */
	mutable?: boolean;
	/** Host-managed execution contract for product-owned workflows; never parsed from task/eval arguments. */
	managedSubagentExecution?: ManagedSubagentExecution;
	/** The parent agent name forbidden from recursively spawning itself. */
	blockedAgent?: string;
	/** Preserve a completed temporary artifacts directory for an agent:// handle. */
	retainArtifacts?: boolean;
	/**
	 * Invoked instead of immediate cleanup when a temporary artifacts
	 * directory is retained (`retainArtifacts`). Callers that outlive this
	 * call — e.g. an async job body — take ownership of the returned
	 * disposal closure and MUST eventually run it once the retained handle
	 * is no longer needed, or the directory leaks for the process lifetime.
	 */
	onArtifactsRetained?: (cleanup: () => Promise<void>) => void;
	/** Task UI agents keep live registry references; eval one-shots normally do not. */
	keepAlive?: boolean;

	/** Task frontends may inherit LSP; eval frontends normally set this false. */
	enableLsp?: boolean;
	/** Explicitly pass false for plan mode or invocation kinds that must not use IRC. */
	enableIrc?: boolean;
	/** `0` disables executor wall-clock timeout. Undefined inherits settings. */
	maxRuntimeMs?: number;
	/** Kernel-defined tools explicitly exposed to this child. */
	customTools?: CustomTool[];
	/** Workpool items accepted by the child yield tool during this turn. */
	workPoolYieldItems?: WorkPoolYieldItem[];
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
}

/** A normalized preflight result, reusable by tests and adapters. */
export interface EffectiveSubagentPolicy {
	discovery: DiscoveryResult;
	agentName: string;
	agent: AgentDefinition;
	effectiveAgent: AgentDefinition;
	modelOverride?: string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Extension routing note explaining a `before_subagent_spawn` model replacement. */
	modelRoute?: string;
	/** Exact-name `task.agentServiceTierOverrides` entry for this agent, applied after model resolution. */
	serviceTierOverride?: ServiceTierInheritSettingValue;
	/** Exact-name entry normalized to both child compaction threshold fields. */
	compactionThresholdOverride?: CompactionThresholdPair;
	parentActiveModelPattern?: string;
	schema: StructuredSubagentSchemaResolution;
	/** How this run executes: ordinary clone (with its disposition), host-managed, or plan-attenuated. */
	execution: SubagentExecutionPolicy;
	/** LSP mutation policy forwarded to child session construction; `false` grants writable LSP to ordinary clones. */
	lspReadOnly?: boolean;
	enableLsp: boolean;
	enableIrc: boolean;
}

/** Settled child execution plus data needed by the frontends' own rendering. */
export interface StructuredSubagentResult {
	result: SingleResult;
	policy: EffectiveSubagentPolicy;
	mergeSummary: string;
	changesApplied: boolean | null;
	artifactsDir: string;
	temporaryArtifacts: boolean;
}

/** Machine-readable failure category so adapters can retain their native errors. */
export class StructuredSubagentError extends Error {
	readonly kind: "preflight" | "isolation" | "execution";
	/** The child's settled result, when the child finished before a later step failed. */
	readonly result?: SingleResult;

	constructor(
		kind: "preflight" | "isolation" | "execution",
		message: string,
		options?: ErrorOptions & { result?: SingleResult },
	) {
		super(message, options);
		this.name = "StructuredSubagentError";
		this.kind = kind;
		this.result = options?.result;
	}
}

const PLAN_MODE_TOOLS = ["read", "grep", "glob", "web_search"] as const;

function renderSubagentPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim() });
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function sanitizeAgentId(value: string | undefined): string | undefined {
	const trimmed = trimToUndefined(value);
	const sanitized = trimmed?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || undefined;
}

function resolveSchema(request: StructuredSubagentRequest, agent: AgentDefinition): StructuredSubagentSchemaResolution {
	const mode = request.schemaMode ?? request.session.outputSchemaMode ?? "permissive";
	if (Object.hasOwn(request, "outputSchema")) {
		return { schema: request.outputSchema, source: "caller", mode, outputSchemaOverridesAgent: true };
	}
	if (agent.output !== undefined) {
		return { schema: agent.output, source: "agent", mode, outputSchemaOverridesAgent: false };
	}
	if (request.session.outputSchema !== undefined) {
		return { schema: request.session.outputSchema, source: "session", mode, outputSchemaOverridesAgent: false };
	}
	return { schema: undefined, source: "none", mode, outputSchemaOverridesAgent: false };
}

function createPlanModeAgent(agent: AgentDefinition): AgentDefinition {
	const tools = [...PLAN_MODE_TOOLS, ...(agent.tools ?? []).filter(tool => tool === "ast_grep")];
	return {
		...agent,
		systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
		tools,
		spawns: undefined,
		prewalk: undefined,
	};
}

function assertPlanControlsAllowed(request: StructuredSubagentRequest, planMode: boolean): void {
	if (!planMode) return;
	if (request.customTools?.length) {
		throw new StructuredSubagentError("preflight", "Eval-defined tools are unavailable in plan mode.");
	}
	if (request.mutable === true) {
		throw new StructuredSubagentError("preflight", "Mutable subagent execution is unavailable in plan mode.");
	}
}

/** Reject the removed isolation request controls by own-key presence, even for false/null/undefined values. */
function assertNoObsoleteControls(request: StructuredSubagentRequest): void {
	if (hasObsoleteSubagentControl(request)) {
		throw new StructuredSubagentError("preflight", OBSOLETE_SUBAGENT_CONTROL_MESSAGE);
	}
	if (request.mutable !== undefined && typeof request.mutable !== "boolean") {
		throw new StructuredSubagentError("preflight", "`mutable` must be a boolean.");
	}
}

function assertDepthAndSpawnAllowed(request: StructuredSubagentRequest, agentName: string): void {
	const taskDepth = request.session.taskDepth ?? 0;
	const maxDepth = cfgTaskMaxRecursionDepth.get(request.session.settings);
	if (!canSpawnAtDepth(maxDepth, taskDepth)) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn another agent at task depth ${taskDepth}; maximum depth is ${maxDepth}.`,
		);
	}
	const blockedAgent = request.blockedAgent ?? $env.PI_BLOCKED_AGENT;
	if (blockedAgent && blockedAgent === agentName) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
		);
	}
	const spawnPolicy = resolveSpawnPolicy(request.session.getSessionSpawns());
	if (!spawnPolicy.enabled || (spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(agentName))) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn '${agentName}'. Allowed: ${spawnPolicy.allowedErrorText}`,
		);
	}
}

/**
 * Resolve every policy shared by task and eval before allocating artifacts or
 * dispatching work. Callers translate {@link StructuredSubagentError} into
 * their own wire-level error surface.
 */
export async function resolveEffectiveSubagentPolicy(
	request: StructuredSubagentRequest,
): Promise<EffectiveSubagentPolicy> {
	assertNoObsoleteControls(request);
	await request.session.settings.reloadFromDisk();
	const spawnPolicy = resolveSpawnPolicy(request.session.getSessionSpawns());
	const agentName = request.agent?.trim() || spawnPolicy.defaultAgent;
	const planMode = request.session.getPlanModeState?.()?.enabled === true;
	assertPlanControlsAllowed(request, planMode);
	assertDepthAndSpawnAllowed(request, agentName);

	const discovery = await discoverAgents(request.session.cwd, undefined, request.session.effectiveExtensionRoots?.());
	const agents = [...discovery.agents, ...(request.session.getSessionAgents?.() ?? [])];
	const agent = getAgent(agents, agentName);
	if (!agent) {
		const available = agents.map(candidate => candidate.name).join(", ") || "none";
		const searched = discovery.searchedDirs?.map(dir => shortenPath(dir)).join(", ") || "none";
		throw new StructuredSubagentError(
			"preflight",
			`Unknown agent "${agentName}". Available: ${available}. Searched: ${searched}`,
		);
	}
	const disabledAgents = cfgTaskDisabledAgents.get(request.session.settings);
	if (disabledAgents.includes(agentName)) {
		const enabled = agents
			.filter(candidate => !disabledAgents.includes(candidate.name))
			.map(candidate => candidate.name);
		throw new StructuredSubagentError(
			"preflight",
			`Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
		);
	}

	// Plan-mode attenuation wins over every other execution contract.
	const managed = planMode
		? undefined
		: (request.managedSubagentExecution ?? request.session.managedSubagentExecution);
	if (managed !== undefined && request.mutable !== undefined) {
		throw new StructuredSubagentError("preflight", "mutable applies only to ordinary cloned subagents.");
	}
	let effectiveAgent = planMode ? createPlanModeAgent(agent) : agent;
	if (!planMode && managed === undefined) {
		// Ordinary spawns share one coding toolset; the definition's `tools` are
		// additive built-in extras on top, joined by caller-supplied eval tools.
		try {
			effectiveAgent = { ...agent, tools: resolveSubagentToolNames(agent, request.customTools ?? []) };
		} catch (error) {
			if (error instanceof SubagentToolPolicyError) {
				throw new StructuredSubagentError("preflight", error.message, { cause: error });
			}
			throw error;
		}
	} else if (managed !== undefined) {
		// An explicit empty spawn list means no authority. The key must be
		// materialized with value undefined — spreading nothing would leak the
		// definition's own spawns through — and downstream presence checks key
		// off `=== undefined`, so the explicit undefined is exactly "absent".
		const managedSpawns = managed.spawns === "*" || (managed.spawns?.length ?? 0) > 0 ? managed.spawns : undefined;
		effectiveAgent = {
			...agent,
			...(managed.toolNames !== undefined ? { tools: normalizeToolNames(managed.toolNames) } : {}),
			...(managed.spawns !== undefined ? { spawns: managedSpawns } : {}),
		};
	}
	const schema = resolveSchema(request, effectiveAgent);
	if (schema.source === "caller" || (schema.source !== "none" && schema.mode === "strict")) {
		const { error } = buildOutputValidator(schema.schema);
		if (error) {
			const scope =
				schema.source === "caller" ? (schema.mode === "strict" ? "strict caller" : "caller") : "strict effective";
			throw new StructuredSubagentError("preflight", `Invalid ${scope} output schema: ${error}`);
		}
	}
	const agentModelOverrides = cfgTaskAgentModelOverrides.get(request.session.settings);
	const agentServiceTierOverrides = validateAgentServiceTierOverrides(
		cfgTaskAgentServiceTierOverrides.get(request.session.settings),
	);
	const serviceTierOverride = Object.hasOwn(agentServiceTierOverrides, agentName)
		? agentServiceTierOverrides[agentName]
		: undefined;
	const compactionThresholdOverrides = validateAgentCompactionThresholdOverrides(
		cfgTaskAgentCompactionThresholdOverrides.get(request.session.settings),
	);
	const compactionThresholdOverride = Object.hasOwn(compactionThresholdOverrides, agentName)
		? compactionThresholdOverrides[agentName]
		: undefined;
	const parentActiveModelPattern = request.session.getActiveModelString?.();
	const modelResolution = {
		requestModel: request.model,
		settingsOverride: agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: request.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: request.session.getModelString?.(),
	};
	// Role identity and patterns come from one call so they cannot be derived
	// from different sources: the expansion below discards the alias, and the
	// child's inherited retry-fallback chain is keyed off the role.
	const { patterns: modelOverride, role: modelRole } = resolveAgentModelSelection(modelResolution);
	let execution: SubagentExecutionPolicy;
	if (planMode) {
		execution = { kind: "plan" };
	} else if (managed !== undefined) {
		execution = { kind: "managed", contract: managed };
	} else {
		// The definition's `mutable` is the apply-back ceiling: a caller may
		// narrow true to false, never widen false to true. Omitted requests
		// resolve to the ceiling itself.
		const ceiling = agent.mutable ?? false;
		const requested = request.mutable ?? ceiling;
		if (requested && !ceiling) {
			throw new StructuredSubagentError(
				"preflight",
				`Agent "${agentName}" does not permit mutable execution; omit mutable or pass mutable: false.`,
			);
		}
		const probe = await probeIsolationRepoRoot(request.session.cwd);
		if (!("repoRoot" in probe)) {
			throw new StructuredSubagentError(
				"preflight",
				`Subagent execution requires an isolated clone, but this workspace cannot provide one: ${probe.unavailable}`,
			);
		}
		execution = {
			kind: "clone",
			disposition: requested ? "merge" : "discard",
			mergeMode: cfgTaskIsolationMerge.get(request.session.settings),
		};
	}
	return {
		discovery,
		agentName,
		agent,
		effectiveAgent,
		modelOverride,
		modelRole,
		serviceTierOverride,
		compactionThresholdOverride,
		parentActiveModelPattern,
		schema,
		execution,
		lspReadOnly:
			execution.kind === "clone" ? false : execution.kind === "managed" ? request.session.lspReadOnly : undefined,
		enableLsp:
			!planMode &&
			(request.enableLsp ?? ((request.session.enableLsp ?? true) && cfgTaskEnableLsp.get(request.session.settings))),
		enableIrc:
			!planMode &&
			(request.enableIrc ??
				(request.session.enableIrc !== false &&
					isIrcEnabled(request.session.settings, request.session.taskDepth ?? 0))),
	};
}

/**
 * Fire `before_subagent_spawn` for an actual child dispatch. Kept out of
 * {@link resolveEffectiveSubagentPolicy} because frontends run that as a
 * side-effect-free preflight too; stateful routing handlers must see exactly
 * one event per spawned child.
 */
async function applySpawnHook(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<EffectiveSubagentPolicy> {
	const emit = request.session.emitBeforeSubagentSpawn;
	if (!emit) return policy;
	const spawnKey =
		request.identity?.id ??
		request.identity?.label ??
		(request.parentToolCallId !== undefined ? `${request.parentToolCallId}:${request.index ?? 0}` : undefined);
	const spawnResult = await emit(
		{
			type: "before_subagent_spawn",
			agent: policy.agentName,
			invocationKind: request.invocationKind,
			modelRole: policy.modelRole,
			patterns: policy.modelOverride ?? [],
			spawnKey,
		},
		request.signal,
	);
	if (spawnResult?.block) {
		throw new StructuredSubagentError("preflight", spawnResult.reason ?? "Subagent spawn blocked by extension.");
	}
	if (spawnResult?.model === undefined) return policy;
	const replacement = resolveConfiguredModelPatterns(spawnResult.model, request.session.settings);
	if (replacement.length === 0) return policy;
	return { ...policy, modelOverride: replacement, modelRoute: spawnResult.note };
}

/** Reserve a session-global agent id only after preflight has succeeded. */
export async function reserveStructuredSubagentId(
	session: ToolSession,
	identity: StructuredSubagentIdentity | undefined,
): Promise<string> {
	if (identity?.id) return identity.id;
	const manager = session.agentOutputManager ?? new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager ??= manager;
	return manager.allocate(sanitizeAgentId(identity?.label) ?? generateTaskName());
}

interface ArtifactLease {
	sessionFile: string | null;
	artifactsDir: string;
	temporary: boolean;
	unregister: (() => void) | undefined;
	/**
	 * Idempotent consumer cleanup request. While an isolation hold is active
	 * this resolves immediately (the clone still needs the directory); the
	 * final hold release performs the deferred physical cleanup.
	 */
	requestCleanup: () => Promise<void>;
	/** Guard the directory for a live isolation clone; returns the hold releaser. */
	holdForIsolation: () => () => Promise<void>;
	/** Files that must outlive clone disposal (published recovery patches). */
	preserveRecoveryFiles: (artifacts: readonly { path: string }[]) => void;
}

function createArtifactLease(
	sessionFile: string | null,
	artifactsDir: string,
	temporary: boolean,
	unregister: (() => void) | undefined,
): ArtifactLease {
	let holdCount = 0;
	let cleanupRequested = false;
	let physicalCleanup: Promise<void> | undefined;
	const preserved = new Set<string>();
	const physicalCleanupOnce = (): Promise<void> => {
		physicalCleanup ??= (async () => {
			if (!temporary) return;
			// Remove everything except files the isolation lifecycle preserved:
			// acknowledged recovery patches outlive the clone.
			for (const entry of await fs.readdir(artifactsDir).catch(() => [])) {
				if (preserved.has(path.join(artifactsDir, entry))) continue;
				await fs.rm(path.join(artifactsDir, entry), { recursive: true, force: true }).catch(() => undefined);
			}
			if (preserved.size === 0) {
				await fs.rm(artifactsDir, { recursive: true, force: true }).catch(() => undefined);
				unregister?.();
			}
		})();
		return physicalCleanup;
	};
	return {
		sessionFile,
		artifactsDir,
		temporary,
		unregister,
		requestCleanup: async () => {
			cleanupRequested = true;
			if (holdCount > 0) return; // the final hold release performs it
			await physicalCleanupOnce();
		},
		holdForIsolation: () => {
			holdCount += 1;
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				holdCount -= 1;
				if (holdCount === 0 && cleanupRequested) await physicalCleanupOnce();
			};
		},
		preserveRecoveryFiles: artifacts => {
			for (const artifact of artifacts) preserved.add(path.resolve(artifact.path));
		},
	};
}

async function leaseArtifacts(
	session: ToolSession,
	invocationKind: StructuredSubagentRequest["invocationKind"],
): Promise<ArtifactLease> {
	const sessionFile = session.getSessionFile();
	if (sessionFile) {
		const artifactsDir = sessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		return createArtifactLease(sessionFile, artifactsDir, false, undefined);
	}
	const artifactsDir = path.join(
		os.tmpdir(),
		`${invocationKind === "eval" ? "omp-eval-agent" : "omp-task"}-${Snowflake.next()}`,
	);
	await fs.mkdir(artifactsDir, { recursive: true });
	return createArtifactLease(null, artifactsDir, true, registerArtifactsDir(artifactsDir));
}

function resolveAutoloadSkills(session: ToolSession, agent: AgentDefinition) {
	const skills = [...(session.skills ?? [])];
	const autoloadSkills = agent.autoloadSkills?.length
		? agent.autoloadSkills.map(name => skills.find(skill => skill.name === name)).filter(skill => skill !== undefined)
		: [];
	return { skills, autoloadSkills };
}

function buildExecutorOptions(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
	lease: ArtifactLease,
	id: string,
): ExecutorOptions {
	const { session } = request;
	const { skills, autoloadSkills } = resolveAutoloadSkills(session, policy.agent);
	const localProtocolOptions = sessionLocalProtocolOptions(session);
	const execution = policy.execution;
	const ordinary = execution.kind === "clone";
	const restrictToolNames =
		ordinary ||
		execution.kind === "plan" ||
		session.restrictToolNames === true ||
		isReadOnlyAgent(policy.effectiveAgent);
	return {
		cwd: session.cwd,
		additionalDirectories: session.additionalDirectories,
		getApiKey: session.getApiKey,
		credentialSourceSessionId: session.getCredentialSourceSessionId?.(),
		agent: policy.effectiveAgent,
		task: renderSubagentPrompt(request.assignment),
		assignment: request.assignment.trim(),
		context: request.context?.trim() || undefined,
		planReference: undefined,
		// Task `name` is the spawn handle (id allocation). Eval `label` is a
		// real UI description. Copy it only for eval so generateTaskLabel can run.
		description: request.invocationKind === "eval" ? trimToUndefined(request.identity?.label) : undefined,
		index: request.index ?? 0,
		parentToolCallId: request.parentToolCallId,
		detached: request.detached,
		id,
		taskDepth: session.taskDepth ?? 0,
		invokedAt: request.invokedAt,
		acquiredAt: request.acquiredAt,
		modelOverride: policy.modelOverride,
		modelRole: policy.modelRole,
		modelRoute: policy.modelRoute,
		serviceTierOverride: policy.serviceTierOverride,
		compactionThresholdOverride: policy.compactionThresholdOverride,
		parentActiveModelPattern: policy.parentActiveModelPattern,
		thinkingLevel: policy.effectiveAgent.thinkingLevel,
		effort: request.effort,
		solutionSpace: request.solutionSpace?.trim() || undefined,
		...(policy.schema.source === "none"
			? {}
			: {
					outputSchemaSource: policy.schema.source,
					outputSchema: policy.schema.schema,
					outputSchemaOverridesAgent: policy.schema.outputSchemaOverridesAgent,
					outputSchemaMode: policy.schema.mode,
				}),
		sessionFile: lease.sessionFile,
		persistArtifacts: !lease.temporary,
		artifactsDir: lease.artifactsDir,
		enableLsp: policy.enableLsp,
		lspReadOnly: policy.lspReadOnly,
		enableIrc: policy.enableIrc,
		maxRuntimeMs: request.maxRuntimeMs,
		restrictToolNames,
		cloneDisposition: ordinary ? execution.disposition : undefined,
		managedSubagentExecution: execution.kind === "managed" ? execution.contract : undefined,
		keepAlive:
			ordinary && execution.disposition === "discard" && request.keepAlive === undefined ? false : request.keepAlive,
		signal: request.signal,
		eventBus: session.eventBus,
		subagentEventBus: session.subagentEventBus,
		onProgress: request.onProgress,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		// Subagent executor sessions never inherit ambient MCP: no manager, no proxies.
		enableMCP: false,
		inheritedSessionAgents: session.getSessionAgents?.(),
		customTools: request.customTools,
		workPoolYieldItems: request.workPoolYieldItems,
		contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
		skills,
		autoloadSkills,
		workspaceTree: session.workspaceTree,
		promptTemplates: session.promptTemplates,
		rules: session.rules,
		// Root policy and module paths have separate jobs: the live policy drives
		// recursive sub-discovery; preloaded paths only avoid re-scanning/reusing
		// parent-bound extension instances while constructing the child.
		extensionRoots: session.effectiveExtensionRoots?.bind(session),
		preloadedExtensionPaths: restrictToolNames ? [] : session.extensionPaths,
		preloadedPreparedExtensions: session.preparedExtensions,
		preloadedCustomToolPaths: restrictToolNames ? [] : session.customToolPaths,
		localProtocolOptions,
		parentArtifactManager: session.getArtifactManager?.() ?? undefined,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentTelemetry: session.getTelemetry?.(),

		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
	};
}

async function loadPlanReference(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<{ path: string; content: string } | undefined> {
	if (policy.execution.kind === "plan") return undefined;
	return loadOverallPlanReference(
		request.session.getPlanReferencePath?.() ?? "local://PLAN.md",
		sessionLocalProtocolOptions(request.session),
	);
}

function buildFailureResult(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
	id: string,
	startedAt: number,
) {
	return (error: unknown): SingleResult => {
		const message = error instanceof Error ? error.message : String(error);
		return {
			index: request.index ?? 0,
			id,
			agent: policy.agent.name,
			agentSource: policy.agent.source,
			task: renderSubagentPrompt(request.assignment),
			assignment: request.assignment.trim(),
			description: request.invocationKind === "eval" ? trimToUndefined(request.identity?.label) : undefined,
			exitCode: 1,
			output: "",
			stderr: message,
			truncated: false,
			durationMs: Date.now() - startedAt,
			tokens: 0,
			requests: 0,
			modelOverride: policy.modelOverride,
			modelRole: policy.modelRole,
			error: message,
		};
	};
}

/**
 * Paths of the on-disk nested patches for `result`. The isolation runner
 * writes them before tearing the workspace down; a result that carries
 * `nestedPatches` without paths (older producers, direct callers) is written
 * here as a fallback. Returns the paths and a note when that fallback failed.
 */
async function resolveNestedPatchPaths(
	result: SingleResult,
	artifactsDir: string,
): Promise<{ paths: string[]; failure?: string }> {
	if (result.nestedPatchPaths) return { paths: result.nestedPatchPaths };
	try {
		return { paths: await persistNestedPatches(artifactsDir, result.id, result.nestedPatches ?? []) };
	} catch (error) {
		return { paths: [], failure: error instanceof Error ? error.message : String(error) };
	}
}

/** Recovery hint appended to an isolated run's failure: every preserved artifact, and the nested-persist fallback failure when there is one. */
async function isolationRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	const nested = await resolveNestedPatchPaths(result, artifactsDir);
	const hint = prompt.render(isolationRecoveryHintTemplate, {
		patchPath: result.patchPath,
		nestedPatchPaths: nested.paths,
		nestedFailure: nested.failure,
		branchName: result.branchName,
	});
	return hint ? ` ${hint}` : "";
}

function attachStructuredOutputMetadata(result: SingleResult, schema: StructuredSubagentSchemaResolution): void {
	if (schema.source === "none") {
		delete result.structuredOutput;
		return;
	}
	if (result.structuredOutput) return;
	// The executor attaches metadata for every payload it validated, so a
	// failed run reaching here never submitted one: the model stream died, the
	// run was cancelled, or the agent exited without yielding. That is not a
	// schema verdict — `result.output` is partial prose, not a payload — and
	// labelling it "invalid" reported provider errors as schema failures with
	// the half-streamed text as the offending data (production 2026-09-21).
	if (result.exitCode !== 0) {
		result.structuredOutput = {
			source: schema.source,
			mode: schema.mode,
			status: "unavailable",
			...(result.error ? { error: result.error } : {}),
		};
		return;
	}
	let fallbackData: unknown = result.output;
	try {
		fallbackData = JSON.parse(result.output);
	} catch {}
	result.structuredOutput = {
		source: schema.source,
		mode: schema.mode,
		status: "valid",
		data: fallbackData,
		...(result.error ? { error: result.error } : {}),
	};
}

/** Name a settled child's exit status and artifact for a post-settle failure message. */
function describeSalvagedWork(result: SingleResult): string {
	const hint = prompt.render(salvagedChildHintTemplate, {
		aborted: result.aborted,
		abortReason: result.abortReason,
		exitCode: result.exitCode,
		error: result.error,
		id: result.id,
		outputPath: result.outputPath,
	});
	return `\n${hint.trim()}`;
}

/**
 * Execute a validated subagent. Preflight errors occur before any artifact
 * lease or child dispatch; callers keep responsibility for their result text.
 */
export async function runStructuredSubagent(request: StructuredSubagentRequest): Promise<StructuredSubagentResult> {
	const policy = await applySpawnHook(request, await resolveEffectiveSubagentPolicy(request));
	const lease = await leaseArtifacts(request.session, request.invocationKind);
	let changesApplied: boolean | null = null;
	let releaseHold: (() => Promise<void>) | undefined;
	let mergeSummary = "";
	let requiresRecoveryArtifacts = false;
	let completedSuccessfully = false;
	let hasValidStructuredOutput = false;
	let deferredCleanup: Promise<void> | undefined;
	// Set once the child returns: every later step (structured-output
	// metadata, isolation merge, nested patch apply) can still throw, and the
	// failure must carry the exit status and artifact the child produced.
	let settled: SingleResult | undefined;
	let retainSalvagedArtifact = false;
	const onSubprocessResult =
		request.invocationKind === "eval"
			? (result: SingleResult) => request.session.recordEvalSubagentUsage?.(result.usage?.output ?? 0)
			: undefined;
	let leasedId: string | undefined;
	let baseOptions: ExecutorOptions | undefined;
	try {
		leasedId = await reserveStructuredSubagentId(request.session, {
			...request.identity,
			label: request.identity?.label ?? (request.invocationKind === "eval" ? "EvalAgent" : undefined),
		});
		const id = leasedId;
		baseOptions = buildExecutorOptions(request, policy, lease, id);
		baseOptions.onCleanupDeferred = completion => {
			deferredCleanup = completion;
		};
		baseOptions.planReference = await loadPlanReference(request, policy);
		const execution = policy.execution;
		const clone = execution.kind === "clone" ? execution : undefined;
		// The session resolver (not a fresh classification of the clone's cwd) so
		// nested isolated spawns inherit the key: a clone's own git root would
		// classify as primary and never match the workspace.related map.
		if (clone) {
			baseOptions.parentWorkspaceKey = (await request.session.resolveRelatedWorkspace?.())?.key ?? undefined;
		}
		let isolationContext: IsolationContext | null = null;
		if (clone) {
			try {
				isolationContext = await prepareIsolationContext(request.session.cwd, {
					baseline: clone.disposition === "merge",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new StructuredSubagentError(
					"isolation",
					`Isolated subagent execution could not be prepared: ${message}`,
					{ cause: error },
				);
			}
		}
		let result: SingleResult;
		if (!isolationContext) {
			result = await runSubprocess(baseOptions);
			onSubprocessResult?.(result);
		} else if (clone) {
			// Guard the artifact directory for the clone's whole lifecycle: the
			// runner owns the hold and releases it after reclamation, retention
			// handoff, or setup failure — consumer eviction must not delete a
			// parked clone's transcript or its only recovery patch. Detached
			// runs are fire-and-forget (no revival, no parked clone), so the
			// job's eviction cleanup owns the directory exactly as before.
			releaseHold = request.detached === true ? undefined : lease.holdForIsolation();
			result = await runIsolatedSubprocess({
				baseOptions,
				context: isolationContext,
				preferredBackend: parseIsolationBackend(cfgIsolationBackend.get(request.session.settings)),
				agentId: id,
				mergeMode: clone.mergeMode,
				discard: clone.disposition === "discard",
				artifactsDir: lease.artifactsDir,
				description: trimToUndefined(request.identity?.label),
				buildCommitMessage: makeIsolationCommitMessage(request.session),
				buildFailureResult: buildFailureResult(request, policy, id, Date.now()),
				onSubprocessResult,
				preserveRecoveryFiles: lease.preserveRecoveryFiles,
				releaseArtifactHold: releaseHold,
			});
		} else {
			throw new StructuredSubagentError("execution", "Isolated context prepared for a non-clone execution.");
		}
		settled = result;
		attachStructuredOutputMetadata(result, policy.schema);
		if (clone && result.cloneDisposition === undefined) result.cloneDisposition = clone.disposition;
		// Discard runs never capture: strip any runner-supplied capture fields so
		// they cannot leak into caller-visible details or recovery bookkeeping.
		if (clone?.disposition === "discard") {
			delete result.patchPath;
			delete result.hasRootChanges;
			delete result.branchName;
			delete result.nestedPatches;
			delete result.nestedPatchPaths;
		}
		hasValidStructuredOutput = result.structuredOutput?.status === "valid";
		requiresRecoveryArtifacts =
			clone !== undefined &&
			(result.exitCode !== 0 || result.error !== undefined || result.aborted === true) &&
			(result.patchPath !== undefined || result.branchName !== undefined || (result.nestedPatches?.length ?? 0) > 0);

		if (clone && isolationContext && clone.disposition === "discard") {
			mergeSummary = renderIsolationSummary({ kind: "discarded" });
		} else if (
			clone &&
			isolationContext &&
			clone.disposition === "merge" &&
			result.exitCode === 0 &&
			!result.error &&
			!result.aborted
		) {
			const outcome = await mergeIsolatedChanges({
				result,
				repoRoot: isolationContext.repoRoot,
				mergeMode: clone.mergeMode,
			});
			mergeSummary = outcome.summary;
			changesApplied = outcome.changesApplied;
			if (outcome.changesApplied !== false) {
				const nestedPatchSummary = await applyEligibleNestedPatches({
					result,
					repoRoot: isolationContext.repoRoot,
					mergeMode: clone.mergeMode,
					changesApplied: outcome.changesApplied,
					mergedBranchForNestedPatches: outcome.mergedBranchForNestedPatches,
					commitMessage: makeIsolationCommitMessage(request.session)(),
				});
				mergeSummary += nestedPatchSummary;
				requiresRecoveryArtifacts ||=
					nestedPatchSummary.includes("<system-notification>") && (result.nestedPatches?.length ?? 0) > 0;
			}
		} else if (clone && isolationContext && result.exitCode === 0 && result.error && !result.aborted) {
			// The agent finished but the runner could not capture, persist, or
			// commit its changes. `result.error` names the recovery route (retained
			// workspace, rescued branch); it is the parent's only way to find it.
			mergeSummary = renderIsolationSummary({
				kind: "capture-error",
				error: result.error,
				branchName: result.branchName,
				rootPatchPath: result.hasRootChanges === false ? undefined : result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths ?? [],
			});
		}
		result.changesApplied = clone ? changesApplied : undefined;

		completedSuccessfully = result.exitCode === 0 && !result.error && !result.aborted;
		return {
			result,
			policy,
			mergeSummary,
			changesApplied,
			artifactsDir: lease.artifactsDir,
			temporaryArtifacts: lease.temporary,
		};
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw error;
		// The failure message points the parent at the artifact, so it must
		// survive the cleanup below.
		retainSalvagedArtifact = settled?.outputPath !== undefined;
		throw new StructuredSubagentError(
			"execution",
			`Subagent execution failed: ${error instanceof Error ? error.message : String(error)}${settled ? describeSalvagedWork(settled) : ""}`,
			{ cause: error, result: settled },
		);
	} finally {
		// Safety net for the artifact hold: the runner releases it on every
		// non-adopted exit path, but a dispatched runner that never adopted the
		// agent (mocked dispatches, pre-dispatch failures) must not leave the
		// lease held — that would block consumer cleanup forever. The releaser
		// is idempotent, so real adopted runs keep the hold.
		const stillAdopted =
			baseOptions?.keepAlive !== false && leasedId !== undefined && AgentLifecycleManager.global().has(leasedId);
		if (releaseHold && !stillAdopted) await releaseHold();
		const execution = policy.execution;
		const shouldRetainArtifacts =
			request.detached === true ||
			retainSalvagedArtifact ||
			(request.retainArtifacts && (completedSuccessfully || hasValidStructuredOutput)) ||
			(execution.kind === "clone" &&
				execution.disposition === "merge" &&
				(changesApplied === false || requiresRecoveryArtifacts));
		const shouldCleanup = lease.temporary && !shouldRetainArtifacts;
		if (shouldCleanup) {
			if (deferredCleanup) {
				trackLateCleanup(
					deferredCleanup.then(() => lease.requestCleanup()).then(() => {}),
					{
						resource: "artifacts",
						artifactsDir: lease.artifactsDir,
					},
				);
			} else {
				await lease.requestCleanup();
			}
		} else if (lease.temporary && request.onArtifactsRetained) {
			// Retained rather than cleaned up now: the caller (e.g. an async
			// job body) owns disposing it once the retained handle is no
			// longer needed, instead of it leaking for the process lifetime.
			// The request honors isolation holds and preserved recovery files.
			request.onArtifactsRetained(() => lease.requestCleanup());
		}
	}
}

/** Build the recovery suffix used by adapters after an isolated failure. */
export async function buildStructuredSubagentRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	return isolationRecoveryHint(result, artifactsDir);
}
