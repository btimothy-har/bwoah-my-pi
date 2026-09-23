## Code Review Request

### Mode

{{mode}}

{{#if scope}}
### Review Scope

- Repository root: `{{scope.repositoryRoot}}`
{{#if scope.baseSha}}
- Comparison base (merge base): {{scope.baseSha}}
- Head: `{{scope.headLabel}}` ({{scope.headSha}})
{{#if scope.baseLabel}}
- Selected base branch: `{{scope.baseLabel}}`{{#if scope.baseTipSha}} (tip {{scope.baseTipSha}}){{/if}} — informational; the diff runs from the merge base
{{/if}}
- Only committed changes from the merge base to the head SHA are reviewed; staged and unstaged changes are excluded.
{{/if}}
{{#if scope.commitSha}}
- Commit: {{scope.commitSha}}
{{/if}}
{{/if}}

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Dispatch

Invoke the `code-review` skill (`skill://code-review`) for the code review contract. If the skill is not available in this session, state that limitation and follow the `review_findings` tool's contract directly.

Use the `task` tool with a `tasks` array to dispatch reviewers; the skill decides how the scope partitions.

### Reviewer Instructions

Reviewer MUST:
1. Focus ONLY on assigned files
2. {{#if skipDiff}}{{diffInstruction}}{{else}}MUST use diff hunks below (NEVER re-run git diff){{/if}}
3. {{contextInstruction}}
4. Use incremental `yield` sections for findings and verdict fields; reviewers MUST NOT call `review_findings` — only the primary (as review chair) calls it after synthesis

{{#if skipDiff}}
### Diff Previews

_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### Additional Instructions

{{additionalInstructions}}
{{/if}}
