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

Use `task` to dispatch reviewers in the batch or flat shape specified by the skill for the current `task.batch` setting.

### Chair Diff Capture

{{#if skipDiff}}{{diffInstruction}}. Capture and share the COMPLETE diff before dispatch; the previews below are insufficient.{{else}}The complete diff below is the review input; share it with every reviewer.{{/if}}

### Reviewer Instructions

Reviewer MUST:
1. Focus ONLY on assigned files
2. MUST inspect the chair's complete pinned diff (inline or session-local `local://` reference); NEVER infer a verdict from previews or a moving branch
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
