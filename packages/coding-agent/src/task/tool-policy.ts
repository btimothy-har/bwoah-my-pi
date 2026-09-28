import type { CustomTool } from "../extensibility/custom-tools/types";
import { BUILTIN_TOOL_NAMES, isMCPToolName, normalizeToolNames } from "../tools/builtin-names";
import type { AgentDefinition } from "./types";

/** Tools every ordinary (cloned) subagent requests, in stable order. */
export const COMMON_SUBAGENT_TOOL_NAMES = [
	"read",
	"edit",
	"write",
	"bash",
	"grep",
	"glob",
	"find",
	"ast_grep",
	"ast_edit",
	"lsp",
	"eval",
	"yield",
	"task",
	"hub",
] as const;

const COMMON_SUBAGENT_TOOL_SET: Record<string, true> = Object.fromEntries(
	COMMON_SUBAGENT_TOOL_NAMES.map(name => [name, true]),
);
const BUILTIN_TOOL_SET: Record<string, true> = Object.fromEntries(BUILTIN_TOOL_NAMES.map(name => [name, true]));

/** Invalid additive tool in an agent definition's `tools:` frontmatter. */
export class SubagentToolPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentToolPolicyError";
	}
}

/**
 * Ordinary subagents share one coding toolset; a definition's `tools:` field
 * adds trusted built-in extras on top. Caller-defined eval tools join by name.
 * MCP tools are never admitted. Unknown or non-built-in extras fail fast at
 * preflight rather than silently narrowing the child.
 */
export function resolveSubagentToolNames(agent: AgentDefinition, customTools: readonly CustomTool[]): string[] {
	const extras = normalizeToolNames(agent.tools ?? []);
	for (const name of extras) {
		if (Object.hasOwn(COMMON_SUBAGENT_TOOL_SET, name)) continue;
		if (isMCPToolName(name)) {
			throw new SubagentToolPolicyError(
				`Agent "${agent.name}" declares MCP tool "${name}" in tools; MCP tools are not available to subagents.`,
			);
		}
		if (!Object.hasOwn(BUILTIN_TOOL_SET, name) && name !== "exec") {
			throw new SubagentToolPolicyError(
				`Agent "${agent.name}" declares unknown tool "${name}" in tools; extras must be built-in tool names.`,
			);
		}
	}
	return normalizeToolNames([...COMMON_SUBAGENT_TOOL_NAMES, ...extras, ...customTools.map(tool => tool.name)]);
}
