import type { AgentDefinition } from "./types";

// Only tools safe without ambient session setup may trigger a restricted child.
// Memory-backed readers need backend state that restricted sessions do not initialize.
// `wait` is deliberately absent: blocking on jobs/peers is not needed by a
// read-only child, and admitting it would widen restricted sessions. Do not
// re-classify memory mutators (retain/reflect/memory_edit) as read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
]);

// A spawn policy can inject `task` after the declared tool list is parsed.
export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return (
		!!agent.tools?.length && agent.spawns === undefined && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool))
	);
}
