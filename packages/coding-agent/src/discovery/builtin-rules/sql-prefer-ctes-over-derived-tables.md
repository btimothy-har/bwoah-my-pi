---
description: "Prefer named CTEs over anonymous derived tables in FROM or JOIN clauses"
condition:
  - "(?is)\\b(?:FROM|JOIN)\\s*\\(\\s*(?:SELECT|WITH)\\b"
scope: "tool:edit(*.sql), tool:write(*.sql)"
interruptMode: never
---

Anonymous derived tables hide a logical step inside `FROM (...)` or `JOIN (...)`. Name the step with a CTE when the name makes the query's grain, filtering, or purpose easier to follow.

## Prefer

```sql
-- Harder to scan: the intermediate relation has no durable name
SELECT recent_orders.customer_id
FROM (
  SELECT customer_id, created_at
  FROM orders
  WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
) AS recent_orders;

-- Prefer: relation and purpose visible up front
WITH recent_orders AS (
  SELECT customer_id, created_at
  FROM orders
  WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
)
SELECT recent_orders.customer_id
FROM recent_orders;
```

Most useful when the nested query establishes a grain, is referenced more than once, or needs a name to explain why its transformations belong together.

## Exceptions

- `EXISTS` / `NOT EXISTS` subqueries: correlation to the outer row is the clearest predicate.
- Small scalar subqueries: naming adds more indirection than clarity.
- `LATERAL` joins and `APPLY`: nesting depends on the current outer row.
- Nesting required by the dialect, planner, generated-SQL framework, or a measured performance constraint.
- Derived table genuinely clearer than a distant one-use CTE: keep it; make the alias describe grain or purpose.
