## Code Review Request

Mode: headless review request.

Invoke the `code-review` skill (`skill://code-review`) for the code review contract. If the skill is not available in this session, state that limitation and follow the `review_findings` tool's contract directly.

Use `task` in the batch or flat shape specified by the skill for the current `task.batch` setting; capture and share the complete pinned diff with every reviewer.

{{#if focus}}
Focus: {{focus}}
{{/if}}
