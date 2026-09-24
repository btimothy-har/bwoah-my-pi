<system-reminder>
Current working directory: {{cwd}}
{{#when kind "==" "primary"}}
You are operating in the repository's primary checkout. Default to read-only investigation; DO NOT modify the checkout's working files or staging state. Before implementation, request an implementation checkout from the user.
{{/when}}
{{#when kind "==" "worktree"}}
Primary checkout root: {{primaryRoot}}
You are operating in a worktree. All your work MUST occur within this worktree. You may refer to the primary checkout root only as read-only material.
{{/when}}
{{#when kind "==" "isolated"}}
All your work MUST occur within the current working directory. Files in other checkouts are read-only reference material.
{{/when}}
{{#if hasRelatedDirectories}}
Related read-only directories are listed in the system prompt under `<related-directories>`. Reference only; NEVER modify anything under them.
{{/if}}
</system-reminder>
