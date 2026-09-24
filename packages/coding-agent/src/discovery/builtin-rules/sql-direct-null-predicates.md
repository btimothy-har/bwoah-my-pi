---
description: "Drop redundant COALESCE/IF/CASE wrappers around IS NULL / IS NOT NULL — the predicate is already boolean"
condition:
  - "(?i)\\bCOALESCE\\s*\\([^)]*\\bIS\\s+(NOT\\s+)?NULL\\s*,\\s*(TRUE|FALSE)\\s*\\)"
  - "(?i)\\bIF\\s*\\([^)]*\\bIS\\s+(?:NOT\\s+)?NULL\\s*,\\s*TRUE\\s*,\\s*FALSE\\s*\\)"
  - "(?i)\\bIF\\s*\\([^)]*\\bIS\\s+(?:NOT\\s+)?NULL\\s*,\\s*FALSE\\s*,\\s*TRUE\\s*\\)"
  - "(?i)\\bCASE\\s+WHEN\\b[\\s\\S]{0,120}?\\bIS\\s+(?:NOT\\s+)?NULL\\b\\s+THEN\\s+TRUE\\s+ELSE\\s+FALSE\\s+END\\b"
  - "(?i)\\bCASE\\s+WHEN\\b[\\s\\S]{0,120}?\\bIS\\s+(?:NOT\\s+)?NULL\\b\\s+THEN\\s+FALSE\\s+ELSE\\s+TRUE\\s+END\\b"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

`IS NULL` / `IS NOT NULL` never produce NULL — always TRUE or FALSE. Wrapping them in `COALESCE(..., FALSE)`, `IF(..., TRUE, FALSE)`, or `CASE WHEN ... THEN TRUE ELSE FALSE END` recomputes the same predicate or its inverse.

## Prefer

```sql
-- Bad: wrappers around an already-boolean predicate
SELECT
  COALESCE(concluded_at IS NULL, FALSE) AS is_active_project,
  IF(score IS NOT NULL, TRUE, FALSE) AS has_score,
  CASE WHEN email IS NULL THEN TRUE ELSE FALSE END AS is_missing_email
FROM projects

-- Good: direct boolean expressions
SELECT
  concluded_at IS NULL AS is_active_project,
  score IS NOT NULL AS has_score,
  email IS NULL AS is_missing_email
FROM projects
```

Holds in BigQuery, Postgres, Snowflake, MySQL, standard SQL — a direct predicate works everywhere `IS NULL` does.

## Exceptions

- `COALESCE(bool_col, FALSE)` on a nullable boolean *column*: different pattern, fine — the column itself can be NULL.
- Branches producing non-boolean values (`IF(x IS NULL, 'missing', 'present')`): not redundant.
- Dialect without a native boolean type: convert deliberately (`CAST(x IS NULL AS INT64)` in BigQuery, `CASE WHEN x IS NULL THEN 1 ELSE 0 END` elsewhere), not by habit.
