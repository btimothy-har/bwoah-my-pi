## Code Review Request

Mode: custom instructions.

## Dispatch

Invoke the `code-review` skill (`skill://code-review`) for the code review contract. If the skill is not available in this session, state that limitation and follow the `review_findings` tool's contract directly.

Use the `task` tool with a `tasks` array to dispatch reviewers; every assignment MUST include the user instructions below.

## Reviewer Instructions

Reviewer MUST:
1. Follow the user instructions.
2. Read referenced files/workspace context needed to evaluate them.
3. Use incremental `yield` sections for findings and verdict fields; reviewers MUST NOT call `review_findings` — only the primary (as review chair) calls it after synthesis.

## User Instructions

{{instructions}}
