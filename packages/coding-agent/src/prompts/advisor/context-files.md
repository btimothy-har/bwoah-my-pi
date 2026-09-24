{{#if contextFiles.length}}
<project-context>
Context files: user's standing repository instructions (AGENTS.md etc.); binding on driving agent. Enforce; flag drift immediately; NEVER advise against mandates.
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
{{/if}}
{{#if relatedContextFiles.length}}
<related-context>
Context shared across related directories. Repository instructions above win on conflict.
{{#each relatedContextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</related-context>
{{/if}}
{{#if relatedDirectories.length}}
<related-directories>
Read-only reference directories; NEVER modify anything under these roots.
{{#each relatedDirectories}}
- {{this}}
{{/each}}
</related-directories>
{{/if}}
