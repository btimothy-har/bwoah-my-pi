---
description: "Never compare against NULL with =, !=, or <>; use IS NULL / IS NOT NULL"
condition:
  - "(?is)\\b(?:SELECT|WHERE|AND|OR|ON|HAVING|WHEN|QUALIFY)\\b(?:(?!\\bSET\\b|;)[\\s\\S]){0,240}?(?:=|!=|<>)\\s*NULL\\b"
  - "(?is)\\b(?:SELECT|WHERE|AND|OR|ON|HAVING|WHEN|QUALIFY)\\b(?:(?!\\bSET\\b|;)[\\s\\S]){0,240}?\\bNULL\\s*(?:=|!=|<>)"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

Under three-valued logic every comparison with NULL evaluates to NULL, never TRUE: `WHERE col = NULL` and `WHERE col != NULL` both match nothing. Use the null predicates.

## Prefer

```sql
-- Bad: always NULL, filters out every row
WHERE deleted_at = NULL
WHERE deleted_at != NULL

-- Good
WHERE deleted_at IS NULL
WHERE deleted_at IS NOT NULL
```

NULL-safe equality between two nullable columns:

| Dialect | NULL-safe equality |
|---------|--------------------|
| Postgres, BigQuery, Snowflake, standard SQL | `a IS NOT DISTINCT FROM b` |
| MySQL / MariaDB | `a <=> b` |
| Anywhere else | `(a = b OR (a IS NULL AND b IS NULL))` |

## Exceptions

- Assignment is not comparison: `UPDATE t SET col = NULL` and `VALUES (..., NULL)` are the correct spelling for storing NULL.
- Rare engine-specific literal comparisons (e.g. testing a UDF's NULL handling), when documented.
