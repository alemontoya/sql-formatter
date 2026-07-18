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
