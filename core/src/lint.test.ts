import { describe, it, expect } from "vitest";
import { lintPortability } from "./lint.js";

describe("lintPortability", () => {
  it("returns no findings when source equals target", () => {
    const result = lintPortability("select * from t qualify row_number() over (order by x) = 1", "snowflake", "snowflake");
    expect(result.findings).toEqual([]);
  });

  it("flags QUALIFY when porting snowflake -> redshift", () => {
    const sql = "select id, row_number() over (order by id) as rn from t qualify rn = 1;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-qualify")).toBe(true);
  });

  it("does not flag a snowflake-native construct when target already supports it", () => {
    // Redshift itself doesn't support QUALIFY either, but this asserts the
    // filter is by (source, target) pair, not just "target lacks it" —
    // QUALIFY shouldn't be checked at all when source isn't snowflake.
    const sql = "select id from t where id = 1;";
    const result = lintPortability(sql, "postgres", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-qualify")).toBe(false);
  });

  it("flags FLATTEN(...) and reports the correct line and snippet", () => {
    const sql = ["select value", "from t, lateral flatten(input => t.data) f", "where 1 = 1;"].join("\n");
    const result = lintPortability(sql, "snowflake", "postgres");
    const finding = result.findings.find((f) => f.id === "snowflake-flatten");
    expect(finding).toBeDefined();
    expect(finding!.line).toBe(2);
    expect(finding!.snippet).toBe("flatten(");
  });

  it("flags TRY_CAST and TRY_TO_* functions", () => {
    const sql = "select try_cast(a as int), try_to_number(b) from t;";
    const result = lintPortability(sql, "snowflake", "sqlite");
    const ids = result.findings.map((f) => f.id);
    expect(ids.filter((id) => id === "snowflake-try-cast")).toHaveLength(2);
  });

  it("flags ::VARIANT/::OBJECT/::ARRAY semi-structured casts", () => {
    const sql = "select data::variant, meta::object from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.filter((f) => f.id === "snowflake-semistructured-cast")).toHaveLength(2);
  });

  it("does not flag an unrelated :: cast", () => {
    const sql = "select id::int from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-semistructured-cast")).toBe(false);
  });

  it("flags GETDATE(), IDENTITY(...), DISTKEY/SORTKEY, and APPROXIMATE COUNT for redshift source", () => {
    const sql = [
      "create table t (",
      "  id int identity(1,1),",
      "  created_at timestamp default getdate()",
      ")",
      "distkey(id) sortkey(created_at);",
      "select approximate count(distinct id) from t;",
    ].join("\n");
    const result = lintPortability(sql, "redshift", "postgres");
    const ids = new Set(result.findings.map((f) => f.id));
    expect(ids).toEqual(
      new Set(["redshift-identity", "redshift-getdate", "redshift-distribution", "redshift-approximate-count"]),
    );
  });

  it("flags RETURNING, DISTINCT ON, generate_series, and SERIAL for postgres source", () => {
    const sql = [
      "create table t (id serial primary key);",
      "insert into t default values returning id;",
      "select distinct on (a) a, b from t;",
      "select * from generate_series(1, 10);",
    ].join("\n");
    const result = lintPortability(sql, "postgres", "snowflake");
    const ids = new Set(result.findings.map((f) => f.id));
    expect(ids).toEqual(
      new Set(["postgres-serial-type", "postgres-returning", "postgres-distinct-on", "postgres-generate-series"]),
    );
  });

  it("does not flag postgres RETURNING against sqlite (modern sqlite supports it)", () => {
    const sql = "insert into t default values returning id;";
    const result = lintPortability(sql, "postgres", "sqlite");
    expect(result.findings.some((f) => f.id === "postgres-returning")).toBe(false);
  });

  it("flags AUTOINCREMENT, WITHOUT ROWID, and PRAGMA for sqlite source", () => {
    const sql = ["pragma foreign_keys = on;", "create table t (id integer primary key autoincrement) without rowid;"].join("\n");
    const result = lintPortability(sql, "sqlite", "postgres");
    const ids = new Set(result.findings.map((f) => f.id));
    expect(ids).toEqual(new Set(["sqlite-pragma", "sqlite-autoincrement", "sqlite-without-rowid"]));
  });

  it("does not flag sqlite AUTOINCREMENT against snowflake (snowflake also supports it)", () => {
    const sql = "create table t (id integer primary key autoincrement);";
    const result = lintPortability(sql, "sqlite", "snowflake");
    expect(result.findings.some((f) => f.id === "sqlite-autoincrement")).toBe(false);
  });

  it("reports statementIndex per statement", () => {
    const sql = "select 1 qualify true; select 2 qualify true;";
    const result = lintPortability(sql, "snowflake", "postgres");
    expect(result.findings.map((f) => f.statementIndex)).toEqual([0, 1]);
  });

  it("flags IFF(...) for snowflake source", () => {
    const sql = "select iff(active, 'yes', 'no') from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-iff")).toBe(true);
  });

  it("flags ::TIMESTAMP_TZ / ::TIMESTAMP_LTZ / ::TIMESTAMP_NTZ casts", () => {
    const sql = "select a::timestamp_tz, b::timestamp_ltz, c::timestamp_ntz from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.filter((f) => f.id === "snowflake-timestamp-variant-cast")).toHaveLength(3);
  });

  it("does not flag an unrelated timestamp cast", () => {
    const sql = "select a::timestamp from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-timestamp-variant-cast")).toBe(false);
  });

  it("flags DATE_TRUNC with a bare (unquoted) date part for redshift/postgres targets", () => {
    const sql = "select date_trunc(month, created_at) from t;";
    expect(lintPortability(sql, "snowflake", "redshift").findings.some((f) => f.id === "snowflake-date-trunc-bare-part")).toBe(true);
    expect(lintPortability(sql, "snowflake", "postgres").findings.some((f) => f.id === "snowflake-date-trunc-bare-part")).toBe(true);
  });

  it("does not flag DATE_TRUNC when the date part is already a quoted string", () => {
    const sql = "select date_trunc('month', created_at) from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-date-trunc-bare-part")).toBe(false);
  });

  it("flags single-argument TO_DATE for redshift/postgres targets", () => {
    const sql = "select to_date(created_at) from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-to-date-single-arg")).toBe(true);
  });

  it("does not flag TO_DATE with an explicit format argument", () => {
    const sql = "select to_date(created_at, 'YYYY-MM-DD') from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-to-date-single-arg")).toBe(false);
  });

  it("does not let a nested function call's comma count against TO_DATE's own arg count", () => {
    // The comma inside DATE_TRUNC(month, my_date) is nested (depth 2 relative
    // to TO_DATE's own parens) and must not be mistaken for a second
    // top-level argument to TO_DATE itself.
    const sql = "select to_date(date_trunc(month, my_date)) from t;";
    const result = lintPortability(sql, "snowflake", "redshift");
    expect(result.findings.some((f) => f.id === "snowflake-to-date-single-arg")).toBe(true);
  });

  it("reproduces the real query that surfaced these four rules", () => {
    const sql = [
      "SELECT TO_DATE(DATE_TRUNC(MONTH, my_date::TIMESTAMP_TZ)) AS my_month,",
      "       IFF(my_boolean, 'is true', 'is false') AS is_it_true",
      "  FROM my_table;",
    ].join("\n");
    const result = lintPortability(sql, "snowflake", "redshift");
    const ids = new Set(result.findings.map((f) => f.id));
    expect(ids).toEqual(
      new Set([
        "snowflake-to-date-single-arg",
        "snowflake-date-trunc-bare-part",
        "snowflake-timestamp-variant-cast",
        "snowflake-iff",
      ]),
    );
  });
});
