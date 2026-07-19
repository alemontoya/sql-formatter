import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { format } from "./format.js";
import { tokenize } from "./tokenizer.js";
import type { StyleTemplate } from "./style-template.js";

const defaultTemplate = JSON.parse(
  readFileSync(new URL("../../templates/default.json", import.meta.url), "utf8")
) as StyleTemplate;

const compactTemplate = JSON.parse(
  readFileSync(new URL("../../templates/compact.json", import.meta.url), "utf8")
) as StyleTemplate;

const riverTemplate = JSON.parse(
  readFileSync(new URL("../../templates/river.json", import.meta.url), "utf8")
) as StyleTemplate;

function commentCount(sql: string): number {
  return tokenize(sql).filter((t) => t.type === "lineComment" || t.type === "blockComment").length;
}

describe("format", () => {
  it("produces expected output for a simple query (default template)", () => {
    const sql = "select id, name, email from users where active = true order by created_at desc limit 10;";
    expect(format(sql, defaultTemplate)).toBe(
      [
        "SELECT",
        "  id,",
        "  name,",
        "  email",
        "FROM users",
        "WHERE active = true",
        "ORDER BY created_at DESC",
        "LIMIT 10;",
        "",
      ].join("\n")
    );
  });

  it("keeps a single-item FROM/WHERE on the keyword's own line even with onePerLine set", () => {
    const sql = "select id from users where active = true;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("FROM users");
    expect(out).toContain("WHERE active = true");
    expect(out).not.toContain("FROM\n");
    expect(out).not.toContain("WHERE\n");
  });

  it("does not uppercase the table name in INSERT INTO t (columns) as if it were a function call", () => {
    const sql = "insert into t (a) values (1) returning a;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("INSERT INTO t (a)");
    expect(out).not.toContain("T(a)");
  });

  it("does not uppercase the table name in CREATE TABLE t (columns) as if it were a function call", () => {
    const sql = "create table t (a int, b text);";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("CREATE TABLE t (a int, b text);");
    expect(out).not.toContain("T(a int, b text)");
  });

  it("keeps short lists inline for the compact template", () => {
    const sql = "select id, name, email from users;";
    const out = format(sql, compactTemplate);
    expect(out).toContain("id, name, email");
  });

  it("is idempotent: formatting output again produces the same output", () => {
    const sql = "SELECT a,b,c FROM t WHERE x = 1 AND y = 2 ORDER BY a, b;";
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });

  it("does not insert a space between a unary minus/plus and its operand", () => {
    const sql = "select ADD_MONTHS(x, -12), REPLACE(y, -1, z), -a, +b from t where c = -5 and d = a - 1;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("ADD_MONTHS(x, -12)");
    expect(out).toContain("REPLACE(y, -1, z)");
    expect(out).toContain("-a,");
    expect(out).toContain("+b");
    expect(out).toContain("c = -5");
    // binary subtraction still gets spaces on both sides
    expect(out).toContain("d = a - 1");
  });

  it("keeps SELECT DISTINCT attached to the keyword when the list wraps", () => {
    const sql = "select distinct id, name, email from users;";
    const out = format(sql, defaultTemplate);
    expect(out.split("\n")[0]).toBe("SELECT DISTINCT");
    expect(out).not.toContain("  DISTINCT ");
  });

  it("keeps SELECT DISTINCT inline when the single-column body doesn't wrap", () => {
    const sql = "select distinct id from users;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("SELECT DISTINCT id");
  });

  it("preserves Snowflake's named-argument => operator without splitting into = >", () => {
    const sql = "select * from t, lateral flatten(INPUT => parse_json(t.x), outer => TRUE) as f;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("INPUT => PARSE_JSON(t.x)");
    expect(out).toContain("OUTER => TRUE");
    expect(out).not.toContain("= >");
  });

  it("doesn't put spaces around Snowflake's semi-structured field-access colon (value:id)", () => {
    const sql = "select t.value:id, t.value:nested:field from tbl as t;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("t.value:id");
    expect(out).toContain("t.value:nested:field");
    expect(out).not.toMatch(/value\s*:\s/);
  });

  it("doesn't put spaces around array-indexing brackets (arr[0])", () => {
    const sql = "select agg(x) within group (order by y)[0] from t;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain(")[0]");
    expect(out).not.toContain("[ 0 ]");
    expect(out).not.toMatch(/\)\s+\[/);
  });

  it("handles chained array indexing (arr[0][1])", () => {
    const sql = "select arr[0][1] from t;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("arr[0][1]");
  });

  it("keeps normal spacing for a SQLite bracket-quoted identifier ([col])", () => {
    const sql = "select [col1], [legacy col] from t;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("[col1],");
    expect(out).toContain("[legacy col]");
    expect(out).not.toContain("SELECT[col1]");
  });

  it("wraps a long arithmetic +/- chain onto multiple lines when it exceeds lineWidth", () => {
    const columns = Array.from({ length: 10 }, (_, i) => `some_reasonably_long_column_name_${i}`);
    const sql = `select ${columns.join(" + ")} as total from t;`;
    const out = format(sql, defaultTemplate);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(defaultTemplate.style.lineWidth);
    }
    expect(out).toContain("+ some_reasonably_long_column_name_9 AS total");
  });

  it("keeps a short arithmetic chain inline (doesn't over-wrap)", () => {
    const sql = "select a + b as total from t;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("SELECT a + b AS total");
  });

  it("is idempotent when a wrapped arithmetic chain has a comment mid-chain", () => {
    const items = Array.from({ length: 8 }, (_, i) => `IFF(has_flag_${i} != 'NULL', 1, 0)`);
    const sql = `select ${items.slice(0, 4).join(" + ")} + -- note\n${items.slice(4).join(" + ")} as total from t;`;
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
    expect(commentCount(twice)).toBe(1);
  });
});

describe("format (blank lines between statements)", () => {
  function withBetweenStatements(mode: "preserve" | "collapseToOne" | "none"): StyleTemplate {
    return {
      ...defaultTemplate,
      style: { ...defaultTemplate.style, blankLines: { ...defaultTemplate.style.blankLines, betweenStatements: mode } },
    };
  }

  it('"none" strips blank lines between statements regardless of source spacing', () => {
    const sql = "select a from t;\n\n\nselect b from t;";
    const out = format(sql, withBetweenStatements("none"));
    expect(out).toBe(["SELECT a", "FROM t;", "SELECT b", "FROM t;", ""].join("\n"));
  });

  it('"collapseToOne" always inserts exactly one blank line regardless of source spacing', () => {
    const noGap = format("select a from t;\nselect b from t;", withBetweenStatements("collapseToOne"));
    const bigGap = format("select a from t;\n\n\n\nselect b from t;", withBetweenStatements("collapseToOne"));
    expect(noGap).toBe(bigGap);
    expect(noGap).toBe(["SELECT a", "FROM t;", "", "SELECT b", "FROM t;", ""].join("\n"));
  });

  it('"preserve" keeps the original blank-line count (0, 1, or several) between each pair of statements', () => {
    const sql = ["select a from t;", "select b from t;", "", "select c from t;", "", "", "select d from t;"].join("\n");
    const out = format(sql, withBetweenStatements("preserve"));
    expect(out).toBe(
      [
        "SELECT a",
        "FROM t;",
        "SELECT b",
        "FROM t;",
        "",
        "SELECT c",
        "FROM t;",
        "",
        "",
        "SELECT d",
        "FROM t;",
        "",
      ].join("\n")
    );
  });

  it('"preserve" is idempotent (reformatting the output keeps the same blank-line counts)', () => {
    const sql = ["select a from t;", "", "select b from t;", "", "", "select c from t;"].join("\n");
    const once = format(sql, withBetweenStatements("preserve"));
    const twice = format(once, withBetweenStatements("preserve"));
    expect(twice).toBe(once);
  });
});

describe("format (CASE)", () => {
  it("preserves a comment on its own line before a WHEN branch", () => {
    const sql = ["select case", "  -- studio", "  when x = 1 then 'a'", "  else 'b'", "end from t;"].join("\n");
    const out = format(sql, defaultTemplate);
    expect(out).toContain("-- studio");
    expect(commentCount(out)).toBe(1);
  });

  it("preserves a comment on its own line before the ELSE branch", () => {
    const sql = ["select case", "  when x = 1 then 'a'", "  -- fallback", "  else 'b'", "end from t;"].join("\n");
    const out = format(sql, defaultTemplate);
    expect(out).toContain("-- fallback");
    expect(commentCount(out)).toBe(1);
  });

  it("preserves comments before multiple WHEN branches in the same CASE", () => {
    const sql = [
      "select case",
      "  -- first",
      "  when x = 1 then 'a'",
      "  -- second",
      "  when x = 2 then 'b'",
      "  else 'c'",
      "end from t;",
    ].join("\n");
    const out = format(sql, defaultTemplate);
    expect(out).toContain("-- first");
    expect(out).toContain("-- second");
    expect(commentCount(out)).toBe(2);
  });

  it("is idempotent with a comment before a WHEN branch", () => {
    const sql = ["select case", "  -- studio", "  when x = 1 then 'a'", "  else 'b'", "end from t;"].join("\n");
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });
});

describe("format (parenthesized groups)", () => {
  it("keeps a short function call's arguments inline regardless of lists.onePerLine", () => {
    const sql = "select iff(a, b, c) from t;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("IFF(a, b, c)");
  });

  it("keeps a short IN (...) list inline", () => {
    const sql = "select * from t where x in (1, 2, 3);";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("IN (1, 2, 3)");
  });

  it("wraps a function call's arguments one per line when they overflow lineWidth", () => {
    const args = Array.from({ length: 10 }, (_, i) => `some_reasonably_long_argument_name_${i}`);
    const sql = `select some_function(${args.join(", ")}) from t;`;
    const out = format(sql, defaultTemplate);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(defaultTemplate.style.lineWidth);
    }
    expect(out).toContain("some_reasonably_long_argument_name_9\n");
  });

  it("wraps a long IN (...) list one per line when it overflows lineWidth", () => {
    const values = Array.from({ length: 15 }, (_, i) => `'some_reasonably_long_value_${i}'`);
    const sql = `select * from t where x in (${values.join(", ")});`;
    const out = format(sql, defaultTemplate);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(defaultTemplate.style.lineWidth);
    }
  });

  it("is idempotent when a function call's arguments wrap", () => {
    const args = Array.from({ length: 10 }, (_, i) => `some_reasonably_long_argument_name_${i}`);
    const sql = `select some_function(${args.join(", ")}) from t;`;
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });
});

describe("format (parentheses.subqueryOpenParenSameLine)", () => {
  function withSubqueryParen(sameLine: boolean): StyleTemplate {
    return {
      ...defaultTemplate,
      style: { ...defaultTemplate.style, parentheses: { subqueryOpenParenSameLine: sameLine } },
    };
  }

  it("true (default): glues a subquery's ( to the calling line", () => {
    const sql = "select id from users where id in (select user_id from orders where total > 100);";
    const out = format(sql, withSubqueryParen(true));
    expect(out).toContain("id IN (\n");
    expect(out).not.toMatch(/id IN\n/);
  });

  it("false: moves a subquery's ( onto its own line", () => {
    const sql = "select id from users where id in (select user_id from orders where total > 100);";
    const out = format(sql, withSubqueryParen(false));
    expect(out).toBe(
      [
        "SELECT id",
        "FROM users",
        "WHERE",
        "  id IN",
        "  (",
        "    SELECT user_id",
        "    FROM orders",
        "    WHERE total > 100",
        "  );",
        "",
      ].join("\n")
    );
  });

  it("false: also applies to a CTE's subquery", () => {
    const sql = "with t as (select id from users) select id from t;";
    const out = format(sql, withSubqueryParen(false));
    expect(out).toContain("t AS\n  (\n");
  });

  it("false: does not affect a plain function call's parens (not a subquery)", () => {
    const sql = "select iff(a, b, c) from t;";
    const out = format(sql, withSubqueryParen(false));
    expect(out).toContain("IFF(a, b, c)");
  });

  it("is ignored in keywordAlign mode regardless of the setting (structurally required)", () => {
    const sql = "select id from users where id in (select user_id from orders where total > 100);";
    const sameLine: StyleTemplate = { ...riverTemplate, style: { ...riverTemplate.style, parentheses: { subqueryOpenParenSameLine: true } } };
    const ownLine: StyleTemplate = { ...riverTemplate, style: { ...riverTemplate.style, parentheses: { subqueryOpenParenSameLine: false } } };
    expect(format(sql, ownLine)).toBe(format(sql, sameLine));
  });

  it("is idempotent when false", () => {
    const sql = "select id from users where id in (select user_id from orders where total > 100);";
    const once = format(sql, withSubqueryParen(false));
    const twice = format(once, withSubqueryParen(false));
    expect(twice).toBe(once);
  });
});

describe("format (JOIN)", () => {
  it("keeps a single-condition ON clause inline with the JOIN keyword", () => {
    const sql = "select o.id, c.name from orders o join customers c on o.customer_id = c.id;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("JOIN customers c ON o.customer_id = c.id");
  });

  it("keeps a chain of single-condition joins each inline", () => {
    const sql = [
      "select a.id, b.name, c.total from a",
      "inner join b on a.id = b.a_id",
      "left join c on b.id = c.b_id",
      "cross join d;",
    ].join(" ");
    expect(format(sql, defaultTemplate)).toBe(
      [
        "SELECT",
        "  a.id,",
        "  b.name,",
        "  c.total",
        "FROM a",
        "INNER JOIN b ON a.id = b.a_id",
        "LEFT JOIN c ON b.id = c.b_id",
        "CROSS JOIN d;",
        "",
      ].join("\n")
    );
  });

  it("wraps a multi-condition ON clause exactly one level past the join line (sameLine placement)", () => {
    const sql = [
      "select * from orders o",
      "left join products p on o.product_id = p.id and p.active = true;",
    ].join(" ");
    expect(format(sql, defaultTemplate)).toBe(
      [
        "SELECT *",
        "FROM orders o",
        "LEFT JOIN",
        "  products p ON o.product_id = p.id",
        "    AND p.active = true;",
        "",
      ].join("\n")
    );
  });

  it("wraps a multi-condition ON clause one level past the ON line (newLine placement)", () => {
    const newLineTemplate: StyleTemplate = JSON.parse(JSON.stringify(defaultTemplate));
    newLineTemplate.style.joins.onClausePlacement = "newLine";
    const sql = "select * from a join b on a.x = b.x and a.y = b.y and a.z = b.z;";
    expect(format(sql, newLineTemplate)).toBe(
      [
        "SELECT *",
        "FROM a",
        "JOIN",
        "  b",
        "    ON a.x = b.x",
        "      AND a.y = b.y",
        "      AND a.z = b.z;",
        "",
      ].join("\n")
    );
  });

  it("formats a USING join (no ON clause) without error", () => {
    const sql = "select * from a join b using (id);";
    expect(format(sql, defaultTemplate)).toBe(["SELECT *", "FROM a", "JOIN b USING (id);", ""].join("\n"));
  });
});

describe("format (WITH / CTEs)", () => {
  it("separates multiple CTEs with commas", () => {
    const sql = "with a as (select 1), b as (select 2) select * from a, b;";
    const out = format(sql, defaultTemplate);
    expect(out).toBe(
      [
        "WITH",
        "  a AS (",
        "    SELECT 1",
        "  ),",
        "  b AS (",
        "    SELECT 2",
        "  )",
        "SELECT *",
        "FROM",
        "  a,",
        "  b;",
        "",
      ].join("\n")
    );
  });

  it("separates three CTEs with commas, not just two", () => {
    const sql = "with a as (select 1), b as (select 2), c as (select 3) select * from a, b, c;";
    const out = format(sql, defaultTemplate);
    expect((out.match(/\),/g) ?? []).length).toBe(2);
  });

  it("keeps the RECURSIVE keyword attached to the first CTE name", () => {
    const sql = "with recursive nums as (select 1 as n union all select n + 1 from nums where n < 10) select * from nums;";
    const out = format(sql, defaultTemplate);
    expect(out).toContain("RECURSIVE nums AS (");
  });

  it("packs CTEs onto one line when onePerLine is false and they fit", () => {
    const sql = "with a as (values (1), (2)), b as (values (3)) select * from a, b;";
    const out = format(sql, compactTemplate);
    expect(out.split("\n")[0]).toBe("with a as (values (1), (2)), b as (values (3))");
  });

  it("keeps CTEs one per line when onePerLine is true even if they'd fit inline", () => {
    const sql = "with a as (values (1), (2)), b as (values (3)) select * from a, b;";
    const out = format(sql, defaultTemplate);
    expect(out).toBe(
      ["WITH", "  a AS (VALUES (1), (2)),", "  b AS (VALUES (3))", "SELECT *", "FROM", "  a,", "  b;", ""].join("\n")
    );
  });

  it("round-trips a multi-CTE query idempotently", () => {
    const sql = "with a as (select 1), b as (select 2), c as (select 3) select * from a, b, c;";
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });
});

describe("format (real-world fixture: snowflake-plan-cycles)", () => {
  const fixturePath = new URL("./__fixtures__/snowflake-plan-cycles.sql", import.meta.url);
  const sql = readFileSync(fixturePath, "utf8");

  it("preserves every comment when formatting with the default template", () => {
    const out = format(sql, defaultTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("preserves every comment when formatting with the compact template", () => {
    const out = format(sql, compactTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("is idempotent on the real-world fixture", () => {
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });

  it("produces syntactically balanced parentheses", () => {
    const out = format(sql, defaultTemplate);
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe("format (real-world fixture: financial-forecast-feed)", () => {
  const fixturePath = new URL("./__fixtures__/financial-forecast-feed.sql", import.meta.url);
  const sql = readFileSync(fixturePath, "utf8");

  it("preserves every comment when formatting with the default template", () => {
    const out = format(sql, defaultTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("preserves every comment when formatting with the compact template", () => {
    const out = format(sql, compactTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("is idempotent on the real-world fixture", () => {
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });

  it("produces syntactically balanced parentheses", () => {
    const out = format(sql, defaultTemplate);
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("never inserts a space between a unary sign and its operand (regression: ADD_MONTHS(..., -12))", () => {
    const out = format(sql, defaultTemplate);
    expect(out).not.toMatch(/[-+] \d/);
  });

  it("keeps SELECT DISTINCT on the keyword line even when the column list wraps (regression)", () => {
    const out = format(sql, defaultTemplate);
    expect(out).not.toMatch(/\n\s*DISTINCT /);
  });
});

describe("format (real-world fixture: persona-product-activity-subscription)", () => {
  const fixturePath = new URL("./__fixtures__/persona-product-activity-subscription.sql", import.meta.url);
  const sql = readFileSync(fixturePath, "utf8");

  it("preserves every comment when formatting with the default template", () => {
    const out = format(sql, defaultTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("preserves every comment when formatting with the compact template", () => {
    const out = format(sql, compactTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("is idempotent on the real-world fixture", () => {
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });

  it("is still idempotent on a second reformat pass (regression: comment on a wrapped chain operator)", () => {
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    const thrice = format(twice, defaultTemplate);
    expect(thrice).toBe(twice);
  });

  it("produces syntactically balanced parentheses", () => {
    const out = format(sql, defaultTemplate);
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("wraps the long +-chained SELECT items instead of leaving 700+ char lines (regression)", () => {
    // A few atomic NVL(NULLIF(...)) calls with long identifiers and no +/-
    // to split on legitimately exceed lineWidth by a bit (a separate,
    // pre-existing gap: no wrapping inside function-call arguments) — this
    // just guards against the +/- chains regressing back to one giant line.
    const out = format(sql, defaultTemplate);
    const maxLineLength = Math.max(...out.split("\n").map((line) => line.length));
    expect(maxLineLength).toBeLessThan(150);
  });
});

describe("format (real-world fixture: daily-status-unpivot)", () => {
  const fixturePath = new URL("./__fixtures__/daily-status-unpivot.sql", import.meta.url);
  const sql = readFileSync(fixturePath, "utf8");

  it("preserves every comment when formatting with the default template", () => {
    const out = format(sql, defaultTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("preserves every comment when formatting with the compact template", () => {
    const out = format(sql, compactTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("preserves the comments inside CASE/WHEN blocks specifically (regression)", () => {
    const out = format(sql, defaultTemplate);
    expect(out).toContain("-- Studio");
    expect(out).toContain("-- Distribution");
    expect(out).toContain("-- Reason");
    expect(out).toContain("-- Standalone products have no sub-plans");
  });

  it("is idempotent on the real-world fixture", () => {
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });

  it("produces syntactically balanced parentheses", () => {
    const out = format(sql, defaultTemplate);
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("wraps the long UNPIVOT column list and IN (...) list instead of one giant line (regression)", () => {
    const out = format(sql, defaultTemplate);
    const maxLineLength = Math.max(...out.split("\n").map((line) => line.length));
    expect(maxLineLength).toBeLessThan(150);
  });
});

describe("format (keywordAlign layout)", () => {
  it("right-aligns SELECT/FROM/WHERE to a shared column", () => {
    const sql = "select id, name from users where active = true;";
    expect(format(sql, riverTemplate)).toBe(
      ["SELECT id, name", "  FROM users", " WHERE active = true;", ""].join("\n")
    );
  });

  it("right-aligns JOIN/ON and a wrapped multi-condition AND to the same column", () => {
    const sql = "select a.id, b.name from a join b on a.id = b.id and a.x = b.x where a.active = true;";
    expect(format(sql, riverTemplate)).toBe(
      [
        "SELECT a.id, b.name",
        "  FROM a",
        "  JOIN b",
        "    ON a.id = b.id",
        "   AND a.x = b.x",
        " WHERE a.active = true;",
        "",
      ].join("\n")
    );
  });

  it("right-pads WITH and glues the CTE name to it, with the subquery on its own line", () => {
    const sql = "with t as (select id from users) select id from t;";
    expect(format(sql, riverTemplate)).toBe(
      ["WITH   t AS", "       (SELECT id", "          FROM users", "       )", "SELECT id", "  FROM t;", ""].join(
        "\n"
      )
    );
  });

  it("computes the shared column dynamically from whichever keywords are actually present, not a fixed width", () => {
    // Only WHERE(5)/RETURNING(9) are in this scope (DELETE FROM is a
    // preamble, excluded from the family) — RETURNING is wider than WHERE,
    // so WHERE must right-pad out further than its own 5 characters to
    // match RETURNING's width, not some hardcoded SELECT-sized column.
    const sql = "delete from t where id = 1 returning id;";
    expect(format(sql, riverTemplate)).toBe(["DELETE FROM t", "WHERE     id = 1", "RETURNING id;", ""].join("\n"));
  });

  it("aligns JOIN variants (LEFT JOIN, CROSS JOIN) to FROM's column, not their own length", () => {
    const sql = "select a.id from a left join b on a.id = b.id cross join c;";
    expect(format(sql, riverTemplate)).toBe(
      ["SELECT a.id", "  FROM a", "  LEFT JOIN b", "    ON a.id = b.id", "  CROSS JOIN c;", ""].join("\n")
    );
  });

  it("aligns GROUP BY/HAVING/ORDER BY to WHERE's leading column, not their own (longer) word length", () => {
    // Verified against a real fixture (financial-forecast-feed.sql, "WHERE
    // pr.plan_family != 'Reason'" / "GROUP BY 1, 2"): both keywords start at
    // the identical leading column (9 spaces in) even though "GROUP BY" (8
    // chars) is longer than "WHERE" (5) — they borrow WHERE's *starting*
    // column, the same way JOIN variants borrow FROM's, not a shared body
    // content column past the keyword. HAVING (6 chars) and ORDER BY (8
    // chars) follow the identical codepath (canonicalFamilyWord), so this
    // also locks in behavior for the two keywords no real fixture exercises.
    const sql = "select a, count(*) as n from t where active = true group by a having count(*) > 1 order by n desc;";
    expect(format(sql, riverTemplate)).toBe(
      [
        "SELECT a, COUNT(*) AS n",
        "  FROM t",
        " WHERE active = true",
        " GROUP BY a",
        " HAVING COUNT(*) > 1",
        " ORDER BY n DESC;",
        "",
      ].join("\n")
    );
  });

  it("widens GROUP BY/HAVING/ORDER BY's shared leading column when SELECT/FROM are the narrower reference", () => {
    // Same borrow-WHERE's-column mechanism, but here WHERE isn't present at
    // all — GROUP BY/HAVING/ORDER BY still borrow the literal "WHERE"
    // reference width (5), which happens to be wider than FROM's 4, so FROM
    // right-pads out one extra column to match.
    const sql = "select a from t group by a having count(*) > 1 order by a;";
    expect(format(sql, riverTemplate)).toBe(
      ["SELECT a", "  FROM t", " GROUP BY a", " HAVING COUNT(*) > 1", " ORDER BY a;", ""].join("\n")
    );
  });

  it("is idempotent", () => {
    const sql =
      "with t as (select a, b from x where a > 1 and b < 2) select id, name from t join y on t.id = y.id where active = true;";
    const once = format(sql, riverTemplate);
    const twice = format(once, riverTemplate);
    expect(twice).toBe(once);
  });

  it("indents CASE/WHEN/END from the aligned content column, not from column zero", () => {
    const sql = "select case when a = 1 then 'x' else 'y' end as col from t;";
    expect(format(sql, riverTemplate)).toBe(
      [
        "SELECT CASE",
        "         WHEN a = 1 THEN 'x'",
        "         ELSE 'y'",
        "       END AS col",
        "  FROM t;",
        "",
      ].join("\n")
    );
  });
});

for (const fixtureName of [
  "learning-active-users-subscriptions",
  "snowflake-plan-cycles",
  "financial-forecast-feed",
  "persona-product-activity-subscription",
]) {
  describe(`format (keywordAlign layout, real-world fixture: ${fixtureName})`, () => {
    const fixturePath = new URL(`./__fixtures__/${fixtureName}.sql`, import.meta.url);
    const sql = readFileSync(fixturePath, "utf8");

    it("preserves every comment", () => {
      const out = format(sql, riverTemplate);
      expect(commentCount(out)).toBe(commentCount(sql));
    });

    it("is idempotent", () => {
      const once = format(sql, riverTemplate);
      const twice = format(once, riverTemplate);
      expect(twice).toBe(once);
    });

    it("produces syntactically balanced parentheses", () => {
      const out = format(sql, riverTemplate);
      const opens = (out.match(/\(/g) ?? []).length;
      const closes = (out.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    });
  });
}

describe("format (real-world fixture: learning-active-users-subscriptions)", () => {
  const fixturePath = new URL("./__fixtures__/learning-active-users-subscriptions.sql", import.meta.url);
  const sql = readFileSync(fixturePath, "utf8");

  it("preserves every comment when formatting with the default template", () => {
    const out = format(sql, defaultTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("preserves every comment when formatting with the compact template", () => {
    const out = format(sql, compactTemplate);
    expect(commentCount(out)).toBe(commentCount(sql));
  });

  it("is idempotent on the real-world fixture", () => {
    const once = format(sql, defaultTemplate);
    const twice = format(once, defaultTemplate);
    expect(twice).toBe(once);
  });

  it("produces syntactically balanced parentheses", () => {
    const out = format(sql, defaultTemplate);
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("doesn't space out the array-indexing bracket after WITHIN GROUP (...) (regression)", () => {
    const out = format(sql, defaultTemplate);
    expect(out).toContain(")[0]");
    expect(out).not.toContain("[ 0 ]");
  });
});
