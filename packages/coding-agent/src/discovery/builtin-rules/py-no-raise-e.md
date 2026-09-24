---
description: "Re-raise with bare `raise`, not `raise e`, inside an except handler"
condition: "(?m)^([ \\t]*)except[ \\t]+[\\w.()]+[ \\t]+as[ \\t]+([A-Za-z_]\\w*)[ \\t]*:[^\\n]*\\n(?:\\1[ \\t]+[^\\n]*\\n)*?\\1[ \\t]+raise[ \\t]+\\2[ \\t]*(?:#.*)?$"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

Inside `except ... as e:`, `raise e` re-raises as if the exception originated at the `raise` line, adding a confusing traceback frame. Bare `raise` keeps the original traceback intact.

## Prefer

```python
# Bad — traceback gains an extra frame
try:
    process()
except ProcessError as e:
    logger.exception("Processing failed")
    raise e

# Good — original traceback preserved
try:
    process()
except ProcessError:
    logger.exception("Processing failed")
    raise
```

- Same exception: bare `raise`.
- Different exception: `raise DomainError(...) from e` to keep the chain explicit.

## Allowed

`raise e` outside the active handler — re-raising an exception object stored earlier, or one received as a callback value. Inside the handler that caught it, use bare `raise`.
