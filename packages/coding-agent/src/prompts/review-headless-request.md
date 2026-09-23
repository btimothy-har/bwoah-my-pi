## Code Review Request

Mode: headless review request.

Invoke the `code-review` skill (`skill://code-review`) for the code review contract. If the skill is not available in this session, state that limitation and follow the `review_findings` tool's contract directly.

Use the `task` tool with a `tasks` array to dispatch reviewers for recent code changes; the skill decides how the scope partitions.

{{#if focus}}
Focus: {{focus}}
{{/if}}
