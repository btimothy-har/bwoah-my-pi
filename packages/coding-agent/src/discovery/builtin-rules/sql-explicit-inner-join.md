---
description: "Spell out INNER JOIN instead of a bare JOIN keyword"
condition:
  - "(?im)(?<!(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|OUTER|SEMI|ANTI|ASOF)\\s+)\\bJOIN\\b"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

Bare `JOIN` is `INNER JOIN` in every mainstream dialect. Spelling it out costs one word and removes the ambiguity a reader must resolve, especially in queries mixing join types.

## Prefer

```sql
-- Less clear
FROM orders AS o
JOIN users AS u ON o.user_id = u.id
LEFT JOIN addresses AS a ON u.address_id = a.id

-- Clearer: every join states its type
FROM orders AS o
INNER JOIN users AS u ON o.user_id = u.id
LEFT JOIN addresses AS a ON u.address_id = a.id
```

## Exceptions

- `CROSS JOIN`: distinct join type with no `INNER` spelling; leave as is.
- Surrounding codebase and lint config deliberately use bare `JOIN`: consistency wins.
