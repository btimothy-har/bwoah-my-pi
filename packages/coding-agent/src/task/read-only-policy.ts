import type { AgentDefinition } from "./types";

// Tool names with no mutation-capable actions; this also guards restricted subagent sessions.
// Memory and session mutators are excluded even when their approval tier is "read".
// `hub` is deliberately absent: it declares `approval = hubApproval`, a
// parameter-dependent function that returns "exec" for start/stop/restart,
// process-stdin `send`, unrecognized ops and malformed params. Do not re-add it.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
	"recall",
	"reflect",
]);

// A spawn policy can inject `task` after the declared tool list is parsed.
export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return (
		!!agent.tools?.length && agent.spawns === undefined && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool))
	);
}
