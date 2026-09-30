```
agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", mutable?=None{{#if evalTools}}, tools?=None{{/if}}) → AgentHandle
    Spawns a background subagent in a writable isolated clone of the checkout and returns immediately. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `mutable` asks to apply a successful run's changes back (`true` only when the agent definition permits it, `false` discards, omitted uses the definition default).{{#if evalTools}} `tools`: names of your @tool-defined tools the child may call.{{/if}}
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, mutable{{#if evalTools}}, tools{{/if}} }).{{/if}}
workpool(agent?=None, name?=None, context?=None, mutable?=None{{#if evalTools}}, tools?=None{{/if}}) → WorkPool
    {{#if eagerDelegation}}Default for 2+ independent items.{{else}}Keep-alive worker pool for a batch of independent items.{{/if}} `mutable` pins every worker's clone disposition at creation (`true` merges each item's changes via fresh one-shot clones when the definition permits, `false` discards, omitted uses the definition default). `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver.{{#if waitTool}} Completely blocked? Leave `eval` and call `wait`;{{/if}} NEVER poll. `eval.workpool.freshAgents=true` uses a new agent per item.
```

<dag>
Acyclic waves of handles:
- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** No node waits on its own descendant.
</dag>
