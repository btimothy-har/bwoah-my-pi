---
description: "Prefer half-open range predicates (>= / <) over BETWEEN for date and timestamp bounds"
condition:
  - "(?i)\\bBETWEEN\\s+(DATE|DATETIME|TIMESTAMP)\\s+'"
  - "(?i)\\bBETWEEN\\s+'\\d{4}-\\d{2}-\\d{2}"
  - "(?i)\\bBETWEEN\\s+[\\w.()]+\\s+AND\\s+(DATE\\s+|DATETIME\\s+|TIMESTAMP\\s+)?'\\d{4}-\\d{2}-\\d{2}"
  - "(?i)\\b\\w+(_date|_at|_time|_timestamp)\\s+BETWEEN\\b"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

`BETWEEN` is inclusive on both ends. On timestamp/datetime columns that mis-buckets boundary rows: `BETWEEN '2024-01-01' AND '2024-12-31'` drops everything after midnight on the 31st; adjacent months spelled `... AND '2024-02-01'` double-count the boundary instant. Use a half-open range — exact for dates and timestamps alike.

## Prefer

```sql
-- Bad: inclusive end misbehaves on timestamps
WHERE created_at BETWEEN '2024-01-01' AND '2024-01-31'

-- Good: half-open range, correct for DATE and TIMESTAMP
WHERE created_at >= '2024-01-01'
  AND created_at < '2024-02-01'
```

Half-open ranges also keep index use: plain comparisons on the column, handled directly by every planner.

## Exceptions

- Numeric and lexical ranges (`BETWEEN 1 AND 10`, `BETWEEN 'A' AND 'M'`): what `BETWEEN` is for.
- Pure `DATE` columns with whole-day bounds where the inclusive end is exactly intended: correct as written; half-open still preferred for consistency.
- Typed literals (`DATE '2024-01-01'` in BigQuery/Postgres/standard SQL): same half-open advice.
