---
description: "Catch specific exception types; reserve `except Exception` for explicit boundaries"
condition: "(?m)^[ \\t]*except[ \\t]+\\(?[ \\t]*(?:Exception|BaseException)\\b"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

`except Exception` (or `BaseException`) deep in program logic masks failures you did not anticipate. Catch the specific types the `try` block can raise.

## Why

- Hides programming errors (`NameError`, `TypeError`, `AttributeError`) that should crash loudly in development.
- `BaseException` additionally swallows `KeyboardInterrupt` and `SystemExit`.
- Specific clause documents the contract of the guarded code.

## Prefer

```python
# Bad — masks unrelated bugs
try:
    data = json.loads(payload)
except Exception:
    return None

# Good — names the expected failure
try:
    data = json.loads(payload)
except json.JSONDecodeError as e:
    raise ValidationError(f"Invalid payload: {e}") from e
```

## Allowed

Top-level boundaries only — `main()`, a request handler, a background-job wrapper — with explicit behavior: log with traceback, return 500, mark the job failed, exit with status. A boundary catch without explicit behavior is a silent failure.
