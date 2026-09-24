---
description: "Default to UNION ALL; write UNION DISTINCT explicitly only when deduplication is intended"
condition:
  - "(?i)\\bUNION\\b(?!\\s+(ALL|DISTINCT)\\b)"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

Bare `UNION` means `UNION DISTINCT`: the engine sorts or hashes the combined rows to dedup — an expensive pass, usually unintended, that can silently drop rows you expected to keep. Spell out what you mean.

## Prefer

```sql
-- Preferred default: no dedup pass, rows kept as-is
SELECT worker_id, 'active' AS status FROM active_workers
UNION ALL
SELECT worker_id, 'terminated' AS status FROM terminated_workers

-- Dedup genuinely required: say so, and why
SELECT email FROM employees
UNION DISTINCT  -- employees and contractors overlap
SELECT email FROM contractors
```

`UNION ALL` is valid everywhere. `UNION DISTINCT` is the explicit spelling in BigQuery, Snowflake, Postgres, standard SQL; dialects rejecting `DISTINCT` (older MySQL) use bare `UNION` plus a short comment stating dedup is intended.

## Exceptions

- Sets provably disjoint by construction (e.g. partitioned by a literal status column): `UNION ALL` is still right — that is the point of the default.
- Duplicates expected and unwanted: `UNION DISTINCT` (or bare `UNION` where unsupported) with a comment explaining the overlap.
