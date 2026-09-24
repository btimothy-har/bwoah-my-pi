---
description: "Give every ROW_NUMBER() window an ORDER BY so the numbering is deterministic"
condition:
  - "(?i)ROW_NUMBER\\s*\\(\\s*\\)\\s*OVER\\s*\\((?:(?!ORDER\\s+BY)(?:[^()]|\\([^()]*\\)))*\\)"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

`ROW_NUMBER()` without `ORDER BY` numbers rows in whatever order the engine reads the partition. Nondeterministic: the same query keeps a different row per run — exactly the failure when the numbering drives dedup (`rn = 1`).

## Prefer

```sql
-- Bad: which row gets rn = 1 is arbitrary and unstable
ROW_NUMBER() OVER (PARTITION BY project_id, user_id) AS rn

-- Good: ordering states the keep-rule; unique tiebreaker makes it total
ROW_NUMBER() OVER (
  PARTITION BY project_id, user_id
  ORDER BY created_at DESC, worker_id
) AS rn
```

Write `ORDER BY` to express the business rule (most recent, highest priority, …) and append a unique column as tiebreaker so ties cannot flip between runs.

## Exceptions

- Numbering only distinguishes rows and nothing downstream depends on which row gets which number: any order is semantically fine, but an explicit `ORDER BY` (or a comment stating the numbering is intentionally arbitrary) still documents the choice.
- `ORDER BY (SELECT NULL)` declares "arbitrary on purpose"; prefer a real ordering when one exists.
