---
description: "Remove try/except wrappers whose handler only bare-reraises; call the code directly"
condition: "(?m)^([ \\t]*)except\\b[^\\n]*:[^\\n]*\\n\\1[ \\t]+raise[ \\t]*(?:#[^\\n]*)?(?=\\n(?!\\1[ \\t]+\\S)|(?![\\s\\S]))"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

A `try`/`except` whose handler is only bare `raise` adds noise without changing behavior. Delete the wrapper.

## Prefer

```python
# Bad — the except clause accomplishes nothing
def process(data: bytes) -> Result:
    try:
        return transform(data)
    except TransformError:
        raise

# Good — identical behavior, less code
def process(data: bytes) -> Result:
    return transform(data)
```

Keep the `try` only when the handler adds something: `logger.exception()`, conversion via `raise ... from e`, or cleanup. Cleanup that runs either way: `finally` or a context manager, not catch-and-reraise.

## Allowed

A placeholder during active development, or an explicit `raise` kept to satisfy a type checker — temporarily. Should not survive review.
