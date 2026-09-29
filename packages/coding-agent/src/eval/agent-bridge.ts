/**
 * Host-side handler for the eval `agent()` helper.
 */
import { type } from "@oh-my-pi/omptype";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { createEvalCustomTools, describeEvalTools } from "../task/eval-tools";
import {
	buildStructuredSubagentRecoveryHint,
	reserveStructuredSubagentId,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentResult,
} from "../task/structured-subagent";
import { hasObsoleteSubagentControl, OBSOLETE_SUBAGENT_CONTROL_MESSAGE } from "../task/tool-policy";
import type {
	AgentProgress,
	SingleResult,
	StructuredSubagentSchemaMode,
	SubagentCloneDisposition,
} from "@oh-my-pi/pi-tui/tools/task";
import type { NestedRepoPatch } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `agent()` helper across both runtimes. */
export const EVAL_AGENT_BRIDGE_NAME = "__agent__";

const agentArgsSchema = type({
	prompt: "string>0",
	"agent?": "string>0",
	"label?": "string",
	"schema?": "unknown",
	"schemaMode?": "'permissive' | 'strict'",
	"mutable?": "boolean",
	"tools?": "string[]",
	"+": "reject",
});

interface EvalAgentArgs {
	prompt: string;
	agent?: string;
	label?: string;
	schema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	mutable?: boolean;
	tools?: string[];
}

export interface EvalAgentBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Handle returned immediately after an eval subagent job is registered. */
export interface EvalAgentHandleResult {
	id: string;
	agent: string;
}

export interface EvalAgentResult {
	text: string;
	/** Parsed structured data returned by the child executor. */
	data?: unknown;
	details: {
		agent: string;
		id: string;
		model?: string | string[];
		structured: boolean;
		schemaSource?: "caller" | "agent" | "session";
		schemaMode?: StructuredSubagentSchemaMode;
		schemaStatus?: "valid" | "invalid";
		isolated?: boolean;
		cloneDisposition?: SubagentCloneDisposition;
		patchPath?: string;
		/** False when `patchPath` is an empty root diff and the work lives in `nestedPatchPaths`. */
		hasRootChanges?: boolean;
		branchName?: string;
		nestedPatches?: NestedRepoPatch[];
		/** On-disk copies of `nestedPatches`, written before the isolation workspace was removed. */
		nestedPatchPaths?: string[];
		changesApplied?: boolean | null;
		isolationSummary?: string;
	};
}

/** Reject removed subagent isolation request keys by own-key presence, even false/null/undefined. */
export function rejectObsoleteSubagentControls(args: Record<string, unknown>): void {
	if (hasObsoleteSubagentControl(args)) throw new ToolError(OBSOLETE_SUBAGENT_CONTROL_MESSAGE);
}

function parseAgentArgs(args: unknown): EvalAgentArgs {
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		rejectObsoleteSubagentControls(args as Record<string, unknown>);
	}
	const result = agentArgsSchema(args);
	if (result instanceof type.errors) {
		throw new ToolError(`agent() received invalid arguments: ${result.summary}`);
	}
	return result;
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function buildSubagentFailureMessage(agentName: string, result: SingleResult): string {
	const abortReason = trimToUndefined(result.abortReason);
	if (result.aborted && abortReason) return abortReason;
	return (
		trimToUndefined(result.error) ??
		trimToUndefined(result.stderr) ??
		abortReason ??
		`agent() subagent '${agentName}' failed.`
	);
}

async function buildEvalAgentResult(execution: StructuredSubagentResult): Promise<EvalAgentResult> {
	const { result, policy, mergeSummary, changesApplied, artifactsDir } = execution;
	const clone = policy.execution.kind === "clone" ? policy.execution : undefined;
	if (result.exitCode !== 0 || result.error || result.aborted) {
		const failureMessage = buildSubagentFailureMessage(policy.agentName, result)
			.replace(/<\/?system-notification>/g, "")
			.trim();
		const recoveryHint = clone ? await buildStructuredSubagentRecoveryHint(result, artifactsDir) : "";
		throw new ToolError(`${failureMessage}${recoveryHint}`);
	}
	if (clone && changesApplied === false) {
		const summary = mergeSummary.replace(/<\/?system-notification>/g, "").trim();
		const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
		throw new ToolError(
			`agent() isolated apply failed for ${result.id}${summary ? `: ${summary}` : ""}${recoveryHint}`,
		);
	}

	const structuredOutput = result.structuredOutput;
	const structured = structuredOutput?.source !== undefined && structuredOutput.source !== "none";
	if (structured && mergeSummary.includes("<system-notification>")) {
		const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
		throw new ToolError(
			`agent() isolated nested patch apply failed for ${result.id}: ${mergeSummary.replace(/<\/?system-notification>/g, "").trim()}${recoveryHint}`,
		);
	}

	const hasData = structured && structuredOutput !== undefined && Object.hasOwn(structuredOutput, "data");
	const data = structuredOutput?.data;
	const text = structured ? result.output : result.output + mergeSummary;
	const schemaSource = structuredOutput?.source === "none" ? undefined : structuredOutput?.source;
	const schemaMode = structured ? structuredOutput?.mode : undefined;
	const schemaStatus = structuredOutput?.status === "unavailable" ? undefined : structuredOutput?.status;
	const model = result.resolvedModel ?? policy.modelOverride;
	const nestedPatches = result.nestedPatches?.length ? result.nestedPatches : undefined;
	const isolationSummary = mergeSummary ? mergeSummary.trim() : undefined;
	return {
		text,
		...(hasData ? { data } : {}),
		details: {
			agent: result.agent,
			id: result.id,
			...(model !== undefined ? { model } : {}),
			structured,
			...(schemaSource !== undefined ? { schemaSource } : {}),
			...(schemaMode !== undefined ? { schemaMode } : {}),
			...(schemaStatus !== undefined ? { schemaStatus } : {}),
			...(clone ? { isolated: true, changesApplied, cloneDisposition: clone.disposition } : {}),
			...(result.patchPath !== undefined ? { patchPath: result.patchPath } : {}),
			...(result.hasRootChanges !== undefined ? { hasRootChanges: result.hasRootChanges } : {}),
			...(result.branchName !== undefined ? { branchName: result.branchName } : {}),
			...(nestedPatches !== undefined ? { nestedPatches } : {}),
			...(result.nestedPatchPaths?.length ? { nestedPatchPaths: result.nestedPatchPaths } : {}),
			...(isolationSummary !== undefined ? { isolationSummary } : {}),
		},
	};
}

/** Register a background subagent and return its handle immediately. */
export async function runEvalAgent(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentHandleResult> {
	const parsed = parseAgentArgs(args);
	const turnBudget = options.session.getTurnBudget?.();
	if (turnBudget?.hard && turnBudget.total !== null && turnBudget.spent >= turnBudget.total) {
		throw new ToolError(
			`agent() blocked: turn token budget exhausted (${turnBudget.spent}/${turnBudget.total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
		);
	}
	if (parsed.tools?.length && options.session.getPlanModeState?.()?.enabled === true) {
		throw new ToolError("Eval-defined tools are unavailable in plan mode.");
	}

	const customTools = parsed.tools?.length
		? createEvalCustomTools(options.session, await describeEvalTools(options.session, parsed.tools, options.signal))
		: undefined;

	try {
		const policy = await resolveEffectiveSubagentPolicy({
			session: options.session,
			invocationKind: "eval",
			assignment: parsed.prompt,
			...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
			...(Object.hasOwn(parsed, "schema") ? { outputSchema: parsed.schema } : {}),
			...(parsed.schemaMode !== undefined ? { schemaMode: parsed.schemaMode } : {}),
			...(parsed.mutable !== undefined ? { mutable: parsed.mutable } : {}),
			...(customTools ? { customTools } : {}),
		});
		const launchMutable = policy.execution.kind === "clone" ? policy.execution.disposition === "merge" : undefined;
		const manager = options.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("agent() needs the session's async job manager; unavailable here");
		}
		const id = await reserveStructuredSubagentId(options.session, { label: parsed.label });
		const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
		manager.register(
			"task",
			id,
			async ({ signal, reportProgress, markRunning }) => {
				markRunning();
				let latestProgress: AgentProgress | undefined;
				try {
					const execution = await runStructuredSubagent({
						session: options.session,
						invocationKind: "eval",
						assignment: parsed.prompt,
						...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
						...(Object.hasOwn(parsed, "schema") ? { outputSchema: parsed.schema } : {}),
						...(parsed.schemaMode !== undefined ? { schemaMode: parsed.schemaMode } : {}),
						identity: { id, label: parsed.label },
						...(launchMutable !== undefined ? { mutable: launchMutable } : {}),
						...(customTools ? { customTools } : {}),
						retainArtifacts: true,
						keepAlive: true,
						shareEvalSession: false,
						signal,
						onProgress: progress => {
							latestProgress = progress;
							void reportProgress(`Running agent ${progress.id}...`, { progress: [progress] });
						},
					});
					const result = await buildEvalAgentResult(execution);
					await reportProgress(result.text, {
						progress: latestProgress ? [latestProgress] : [],
						evalResult: result,
					});
					return result.text;
				} catch (error) {
					if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
					throw error;
				}
			},
			{ id, agentId: id, ownerId },
		);
		return { id, agent: policy.agentName };
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
		throw error;
	}
}
