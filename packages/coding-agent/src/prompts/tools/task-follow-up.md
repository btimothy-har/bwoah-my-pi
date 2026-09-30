{{#if aborted}}
{{#if resumable}}
{{agentId}} was stopped but is still resumable — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to resume; {{/if}}{{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{else}}
{{agentId}} was aborted — {{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{/if}}
{{else}}
{{#if discarded}}
{{agentId}} ran in a discarded clone and cannot be resumed or messaged — transcript at history://{{agentId}}
{{else}}
{{#if mergeRetained}}
{{agentId}} is now idle — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to follow up; {{/if}}follow-up edits are not applied back automatically. transcript at history://{{agentId}}
{{else}}
{{agentId}} is now idle — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to follow up; {{/if}}transcript at history://{{agentId}}
{{/if}}
{{/if}}
{{/if}}
