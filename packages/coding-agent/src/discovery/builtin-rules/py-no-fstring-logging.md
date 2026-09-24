---
description: "Pass lazy %-args or structured extra to stdlib logging instead of f-strings"
condition: "\\b(?:logging|logger|log)\\.(?:debug|info|warning|warn|error|exception|critical|fatal)\\(\\s*[Ff][\"']"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

An f-string in a stdlib `logging` call formats eagerly, even when the level is disabled. Pass template and arguments separately; formatting happens only when the record is emitted.

## Prefer

```python
# Bad — string built on every call, even with DEBUG off
logger.debug(f"Parsed {len(records)} records from {source}")

# Good — formatted lazily, only if emitted
logger.debug("Parsed %d records from %s", len(records), source)

# Good — structured, parseable context
logger.info("Order processed", extra={"order_id": order.id, "total": total})
```

Lazy args also keep messages uniform for aggregation and avoid double-formatting when values contain `%`.

## Allowed

APIs that require a completed string — non-stdlib logging facades without lazy args, progress/CLI output helpers, exception messages. This rule targets the standard `logging` level methods.
