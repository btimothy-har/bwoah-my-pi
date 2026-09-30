{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Exploratory research MUST use `scout` only when files are unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.
- **Disposition:** {{#if nonCloneExecution}}Subagents in this session run directly in the working tree, not in an isolated clone; `mutable` is unavailable here and is rejected if passed.{{else}}Every spawn runs in a writable isolated clone of the checkout — scratch files, probes, and builds all work there. The agent definition's `mutable` ceiling decides apply-back: agents marked `mutable: apply-back` below integrate a successful initial run's changes into your checkout (mechanism per `task.isolation.merge`); pass `mutable: false` to force discard. Every other agent discards its clone — the yielded result is the deliverable. `mutable: true` on an unmarked agent is rejected.{{/if}}
- Every agent shares the same coding toolset (a definition's `tools:` adds built-in extras on top); `mutable` governs harness apply-back only, never tool access.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`).
    Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`). Use it only when that agent fits the task.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
    NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}  - `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
{{/if}}
{{#if effortEnabled}}  - `effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}
  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
  - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#unless nonCloneExecution}}  - `mutable`: Per-spawn clone disposition. `true` applies a successful run's changes back — only when the agent's definition permits it (marked `mutable: apply-back` below); rejected otherwise. `false` discards the clone. Omitted resolves to the definition's default. Applies the initial run only; follow-up edits are captured but never auto-merged. Never set it on the batch root; it is per item.
{{/unless}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`).
  Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`). Use it only when that agent fits the task.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
  NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}- `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
{{/if}}
{{#if effortEnabled}}- `effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#unless nonCloneExecution}}- `mutable`: Clone disposition for this spawn. `true` applies a successful run's changes back — only when the agent's definition permits it (marked `mutable: apply-back` below); rejected otherwise. `false` discards the clone. Omitted resolves to the definition's default. Applies the initial run only; follow-up edits are captured but never auto-merged.
{{/unless}}
{{/if}}
Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if appliesChanges}} (mutable: apply-back){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
