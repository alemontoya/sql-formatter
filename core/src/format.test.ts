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

describe("format (real-world fixture)", () => {
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
