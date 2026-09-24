---
name: sql
description: "Write, optimize, and run SQL. Apply when authoring or editing .sql files, tuning query performance, or running queries against a warehouse or database (BigQuery, PostgreSQL, others) via CLI clients."
---

# SQL

Determine the engine first, write for that engine, and check cost before executing. Per-statement smells (NULL equality, `NOT IN` subqueries, bare `JOIN`, `UNION`, `BETWEEN` date bounds, boolean `COUNT`) are enforced by the bundled sql-* rules on .sql edits — not repeated here.

## Dialect first

- Identify the engine before writing or running SQL: dbt `profiles.yml`, connection configs, existing queries, or the project's SQLFluff `dialect:` setting.
- Syntax, functions, and the cost model differ per engine — BigQuery bills per bytes scanned; Postgres cost is execution time and I/O on shared hardware. NEVER assume the dialect from a previous project; adapt.
- Client follows engine: `bq` for BigQuery, `psql` for Postgres.

## Running SQL safely

Save the query to a `.sql` file and run it with a CLI client; NEVER paste long SQL into shell one-liners or stream large result sets into the conversation.

BigQuery — on a metered warehouse the dry run is the only cost gate:

```bash
# Estimate bytes scanned before executing
bq query --use_legacy_sql=false --dry_run < query.sql

# Execute; redirect rows to a temp path outside the repository
bq query --use_legacy_sql=false --format=csv --max_rows=1000 \
  < query.sql > "$RESULTS_FILE"
```

- `--max_rows` limits returned rows, not scanned bytes. Only the dry run (or `--maximum_bytes_billed`) bounds cost.
- `$RESULTS_FILE` lives in an OS temp dir (e.g. `$(mktemp)`), never in the repository.
- Inspect with line-bounded reads and `wc -l`; summarize with the output path instead of pasting raw rows.

Postgres and other engines:

```bash
psql -h host -U user -d dbname -f query.sql
```

- `EXPLAIN` (without `ANALYZE`) before any large scan; `EXPLAIN (ANALYZE, BUFFERS)` only when actually executing the query is acceptable.

## Query structure

- State the grain before writing: one row per *what*? Every CTE and join either preserves that grain or changes it deliberately.
- One logical step per CTE. Name CTEs as nouns describing content and grain — `completed_orders`, not `step1`.
- Filter early: push `WHERE` clauses as close to the source tables as possible.
- Validate join cardinality while developing: count rows before and after each join. A one-to-many join that fans out unnoticed inflates every downstream aggregate.
- Explicit columns at boundaries (source reads, final output); `SELECT *` is acceptable only between internal CTEs. On BigQuery this is also a cost issue — see Performance.
- Prefer one pass with conditional aggregation over correlated subqueries per group.
- Window dedup: express the keep-rule in `ORDER BY` and append a unique tiebreaker so the numbering is total:

```sql
-- Keep the most recent event per user; event_id breaks ties deterministically
WITH ranked AS (
  SELECT
    event_id, user_id, kind, occurred_at,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY occurred_at DESC, event_id
    ) AS rn
  FROM user_events
)
SELECT event_id, user_id, kind, occurred_at
FROM ranked
WHERE rn = 1
```

## Performance by engine

### BigQuery

- Billing is per bytes scanned (on-demand): every optimization means fewer bytes or less slot time.
- Filter on the partition column (usually a date/timestamp) in every query against a partitioned table — partition pruning is the main cost lever. Clustering narrows scans within partitions; filter on clustered columns too.
- No `SELECT *` on source reads: columnar storage bills per column read.
- Approximate aggregates where exactness is not required: `APPROX_COUNT_DISTINCT` instead of `COUNT(DISTINCT ...)`, `APPROX_QUANTILES` instead of exact percentiles (~1% error).
- `QUALIFY rn = 1` filters window results without a wrapping subquery.
- Read the console execution details before tuning: high bytes shuffled → expensive joins/aggregations; rows read vs rows returned → filter effectiveness.

### PostgreSQL

- Profile before optimizing: `EXPLAIN (ANALYZE, BUFFERS)`. Watch for Seq Scan on large tables, estimated vs actual row counts, and buffers read vs hit.
- Keep predicates sargable: no functions or casts on an indexed column (`created_at::date = '2024-01-01'` defeats the index). Rewrite as a range predicate on the raw column, or create an expression index matching the function.
- Composite index column order: equality columns first, then range or sort columns.
- Partial indexes (`WHERE status = 'pending'`) and covering indexes (`INCLUDE (...)`) for hot subsets.

## Formatting

Follow the project's lint config (e.g. SQLFluff) and existing conventions — keyword casing, comma placement, `GROUP BY` style — over any imported house style. No lint config: match the surrounding files.
