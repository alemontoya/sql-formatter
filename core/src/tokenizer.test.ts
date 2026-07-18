import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenizer.js";

function roundTrip(sql: string): string {
  return tokenize(sql)
    .map((t) => t.value)
    .join("");
}

const samples: { dialect: string; sql: string }[] = [
  {
    dialect: "postgres",
    sql: `-- get active users\nSELECT id, "full name" FROM users WHERE active = true; -- trailing comment\n`,
  },
  {
    dialect: "postgres (dollar-quoted)",
    sql: `CREATE FUNCTION f() RETURNS int AS $$\n  BEGIN\n    RETURN 1;\n  END;\n$$ LANGUAGE plpgsql;`,
  },
  {
    dialect: "snowflake",
    sql: `WITH recent AS (\n  SELECT * FROM orders WHERE created_at > '2026-01-01' /* block comment */\n)\nSELECT * FROM recent;`,
  },
  {
    dialect: "sqlite",
    sql: "SELECT `id`, [legacy col] FROM t WHERE name LIKE 'O''Brien%';",
  },
];

describe("tokenize", () => {
  for (const { dialect, sql } of samples) {
    it(`is lossless for ${dialect}`, () => {
      expect(roundTrip(sql)).toBe(sql);
    });
  }

  it("classifies comments distinctly from code", () => {
    const tokens = tokenize("SELECT 1 -- comment\n");
    expect(tokens.map((t) => t.type)).toContain("lineComment");
  });

  it("classifies keywords case-insensitively", () => {
    const tokens = tokenize("select * from t");
    expect(tokens[0].type).toBe("keyword");
  });

  it("does not classify quoted identifiers as keywords", () => {
    const tokens = tokenize('"select"');
    expect(tokens[0].type).toBe("quotedIdentifier");
  });

  it("tokenizes Snowflake's named-argument => as a single operator, not = then >", () => {
    const tokens = tokenize("FLATTEN(INPUT => x)").filter((t) => t.type !== "eof");
    const opValues = tokens.filter((t) => t.type === "operator").map((t) => t.value);
    expect(opValues).toContain("=>");
    expect(opValues).not.toContain("=");
    expect(opValues).not.toContain(">");
  });
});

describe("tokenize (real-world fixture)", () => {
  const fixturePath = fileURLToPath(
    new URL("./__fixtures__/snowflake-plan-cycles.sql", import.meta.url)
  );
  const sql = readFileSync(fixturePath, "utf8");

  it("is lossless on a real Snowflake script with heavy comment usage", () => {
    expect(roundTrip(sql)).toBe(sql);
  });

  it("captures every comment in the script", () => {
    const tokens = tokenize(sql);
    const comments = tokens.filter(
      (t) => t.type === "lineComment" || t.type === "blockComment"
    );
    expect(comments.length).toBe(59);
  });
});
