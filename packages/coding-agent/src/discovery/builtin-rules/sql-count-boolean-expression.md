---
description: "Avoid COUNT of a raw boolean comparison; use COUNTIF, FILTER, or SUM(CASE ...) instead"
condition:
  - "(?i)\\bCOUNT\\s*\\(\\s*[A-Za-z_][\\w.]*\\s*(<=|>=|<>|!=|=|<|>)"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

`COUNT(a > b)` counts rows where the comparison is non-NULL — it skips rows where either operand is NULL, while reading as if it counted TRUE results. Conditional aggregation says what it does, with identical NULL semantics.

## Prefer

```sql
-- Unclear: counts non-NULL comparison results
SELECT COUNT(status = 'completed') AS completed FROM orders

-- BigQuery
SELECT COUNTIF(status = 'completed') AS completed FROM orders

-- Postgres, Snowflake, DuckDB, standard SQL
SELECT COUNT(*) FILTER (WHERE status = 'completed') AS completed FROM orders

-- Portable fallback (MySQL, older dialects)
SELECT SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed FROM orders
```

## Exceptions

- `COUNTIF(...)`, `COUNT(*) FILTER (...)`, `COUNT(CASE WHEN ...)`, `COUNT(DISTINCT ...)`: the preferred spellings, not the smell.
- `COUNT(column)` and `COUNT(*)`: ordinary aggregates; their NULL distinction is a separate, legitimate choice.
- Dialect with none of the alternatives (rare): keep the comparison form with a comment noting NULL comparisons are excluded.
