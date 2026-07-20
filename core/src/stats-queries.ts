/**
 * SQL text to hand-run against a real database to help populate a
 * table-stats file (schema/table-stats.schema.json). This tool never
 * executes any of it and never connects to a database — these are just
 * printed/displayed for the user to run themselves and paste the result
 * back in. Shared by the CLI's `advise stats-queries` subcommand and the
 * web UI's Advise tab so both stay in sync off one source of truth.
 */
export const STATS_QUERIES: Record<string, string> = {
  postgres: `-- Run against your Postgres database, restricting the table list to the
-- ones you care about. Produces JSON matching table-stats.schema.json's
-- "tables" object directly — paste the result under a "tables" key.
SELECT jsonb_pretty(jsonb_object_agg(t.relname, jsonb_build_object(
  'rowCount', t.reltuples::bigint,
  'columns', (
    SELECT jsonb_object_agg(s.attname, jsonb_build_object(
      'distinctCount', CASE WHEN s.n_distinct >= 0 THEN s.n_distinct::bigint
                            ELSE (t.reltuples * -s.n_distinct)::bigint END,
      'nullFraction', s.null_frac,
      'indexed', EXISTS (
        SELECT 1 FROM pg_index ix
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
        WHERE ix.indrelid = t.oid AND a.attname = s.attname
      )
    ))
    FROM pg_stats s
    WHERE s.schemaname = n.nspname AND s.tablename = t.relname
  )
)))
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relkind = 'r'
  AND t.relname IN ('table1', 'table2'); -- <- edit this list

-- Note: pg_stats is only populated by ANALYZE — run ANALYZE first (or wait
-- for autovacuum) if a table's columns don't show up.`,

  redshift: `-- Redshift's SQL support is much more limited than real Postgres for this
-- kind of thing: no jsonb_build_object/jsonb_object_agg/jsonb_pretty at
-- all (confirmed against a live cluster, not assumed), so producing the
-- final JSON in one query the way the "postgres" entry does isn't
-- possible here. This instead returns one plain row per table/column —
-- reshape it into table-stats.schema.json's "tables" object by hand,
-- same spirit as the Snowflake/SQLite entries below.
--
-- Also: Redshift has no traditional per-column indexes at all — it's
-- columnar, with SORTKEY/DISTKEY as the real table-level analog — so
-- "indexed" isn't included; same reasoning as the Snowflake entry.
SELECT
  t."table",
  t.tbl_rows                                                    AS rowCount,
  s.attname                                                     AS column,
  CASE WHEN s.n_distinct >= 0 THEN s.n_distinct::bigint
       ELSE (t.tbl_rows * -s.n_distinct)::bigint END            AS distinctCount,
  s.null_frac                                                   AS nullFraction
FROM svv_table_info t
JOIN pg_stats s ON s.schemaname = t.schema AND s.tablename = t."table"
WHERE t.schema = 'public'
  AND t."table" IN ('table1', 'table2') -- <- edit this list
ORDER BY t."table", s.attname;

-- Note: pg_stats is only populated by ANALYZE — run ANALYZE first if a
-- table/column doesn't show up. tbl_rows includes rows pending VACUUM, so
-- treat rowCount as approximate, not exact.`,

  sqlite: `-- SQLite has no built-in per-column cardinality/null-fraction catalog, so
-- this is a per-table template, not a single all-tables query — run it
-- once per table (replace "table1" both places) and merge the results by
-- hand into the stats file's "tables" object.
SELECT
  (SELECT COUNT(*) FROM table1)                         AS rowCount,
  (SELECT COUNT(DISTINCT column1) FROM table1)           AS column1_distinctCount,
  (SELECT COUNT(*) FROM table1 WHERE column1 IS NULL) * 1.0
    / NULLIF((SELECT COUNT(*) FROM table1), 0)           AS column1_nullFraction;

-- For "indexed", check: PRAGMA index_list('table1'); PRAGMA index_info('<index_name>');`,

  snowflake: `-- Snowflake doesn't expose a cheap pre-computed per-column stats catalog
-- to ordinary users the way Postgres's pg_stats does, so this is a
-- per-table template — run once per table and merge results by hand.
SELECT
  COUNT(*)                                                    AS rowCount,
  COUNT(DISTINCT column1)                                     AS column1_distinctCount,
  COUNT_IF(column1 IS NULL) / NULLIF(COUNT(*), 0)              AS column1_nullFraction
FROM table1;

-- For "indexed": Snowflake has no traditional per-column indexes (clustering
-- keys are the closest analog) — you can generally leave "indexed" unset for
-- Snowflake tables; the unindexed-column check just won't fire for them.`,

  generic: `-- No dialect-specific catalog assumed. The universal fallback: run one
-- query per table/column you care about and fill in the stats file by hand.
SELECT
  COUNT(*)                                                     AS rowCount,
  COUNT(DISTINCT column1)                                      AS column1_distinctCount,
  SUM(CASE WHEN column1 IS NULL THEN 1 ELSE 0 END) * 1.0
    / NULLIF(COUNT(*), 0)                                      AS column1_nullFraction
FROM table1;`,
};
