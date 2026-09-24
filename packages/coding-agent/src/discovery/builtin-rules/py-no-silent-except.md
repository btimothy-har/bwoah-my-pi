---
description: "Avoid except handlers whose only statement is `pass` or `...`; handle or log the failure"
condition: "(?m)^([ \\t]*)except\\b[^\\n]*:[^\\n]*\\n\\1[ \\t]+(?:pass|\\.\\.\\.)[ \\t]*(?:#[^\\n]*)?(?=\\n(?!\\1[ \\t]+\\S)|(?![\\s\\S]))"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

An `except` whose only statement is `pass` or `...` discards the failure silently: no log, no propagation, no signal to the caller.

## Why

- Errors become invisible; execution continues in a possibly corrupt state.
- Debugging later means reconstructing what was swallowed, and where.

## Prefer

```python
# Bad — failure is invisible
try:
    cache.invalidate(key)
except CacheError:
    pass

# Good — minimum viable acknowledgment
try:
    cache.invalidate(key)
except CacheError:
    logger.warning("Cache invalidation failed", extra={"key": key})
```

Often better: let it propagate, narrow the `except` to the one expected type, or return an explicit result so callers distinguish failure from absence.

## Allowed

Deliberate best-effort operations (closing an already-broken connection, optional cleanup). Mark intent with a short comment explaining why ignoring is safe, or log at `DEBUG` so the signal is recoverable.
