---
description: "Prefer explicit exception types over a bare `except:` clause"
condition: "(?m)^[ \\t]*except[ \\t]*:[ \\t]*(?:#[^\\n]*)?$"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

Bare `except:` catches everything, including `KeyboardInterrupt`, `SystemExit`, `GeneratorExit`. Name the exceptions the handler actually handles.

## Why

- Intercepts Ctrl+C and interpreter shutdown; processes become hard to stop.
- Hides programming errors (`NameError`, `TypeError`) that should surface in development.
- Named type documents which failures the handler expects.

## Prefer

```python
# Bad — swallows everything, including interrupts
try:
    process()
except:
    recover()

# Good — handles the expected failure
try:
    process()
except TransientError:
    recover()
```

"Any application failure" genuinely intended? `except Exception:` still lets system-level signals propagate.

## Allowed

Process boundary whose handler re-raises after cleanup or logs unconditionally (e.g. a worker loop that must record every outcome). Rare and deliberate.
