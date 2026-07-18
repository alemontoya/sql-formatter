import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inferStyleTemplate } from "./infer.js";
import { format } from "./format.js";
import type { StyleTemplate } from "./style-template.js";

const defaultTemplate = JSON.parse(
  readFileSync(new URL("../../templates/default.json", import.meta.url), "utf8")
) as StyleTemplate;

const riverTemplate = JSON.parse(
  readFileSync(new URL("../../templates/river.json", import.meta.url), "utf8")
) as StyleTemplate;

function infer(sql: string) {
  return inferStyleTemplate(sql, { id: "test", name: "Test", dialect: "generic", baseTemplate: defaultTemplate });
}

function confidenceOf(result: ReturnType<typeof infer>, field: string): number {
  return result.template.source.confidence![field];
}

describe("inferStyleTemplate (synthetic, per-field)", () => {
  it("infers keyword/function/identifier casing with high confidence when consistent", () => {
    const sql = "select count(*) from users where active = true;";
    const { template } = infer(sql);
    expect(template.style.casing.keywords).toBe("lower");
    expect(template.style.casing.functions).toBe("lower");
    expect(template.style.casing.identifiers).toBe("lower");
  });

  it("infers upper keyword casing", () => {
    const { template } = infer("SELECT ID FROM USERS WHERE ACTIVE = TRUE;");
    expect(template.style.casing.keywords).toBe("upper");
  });

  it("infers layout.mode = indent for a plain block-indented example", () => {
    const sql = ["SELECT", "  id,", "  name", "FROM users", "WHERE active = true;"].join("\n");
    const { template } = infer(sql);
    expect(template.style.layout.mode).toBe("indent");
  });

  it("infers layout.mode = keywordAlign for a river-style example", () => {
    const sql = ["SELECT id, name", "  FROM users", " WHERE active = true;"].join("\n");
    const { template } = infer(sql);
    expect(template.style.layout.mode).toBe("keywordAlign");
    expect(confidenceOf(infer(sql), "layout.mode")).toBeGreaterThan(0);
  });

  it("infers indentation size from CASE/WHEN/END nesting", () => {
    const sql = ["SELECT CASE", "    WHEN a = 1 THEN 'x'", "    ELSE 'y'", "END FROM t;"].join("\n");
    const { template } = infer(sql);
    expect(template.style.indentation.size).toBe(4);
  });

  it("infers trailing comma style from a wrapped list", () => {
    const sql = ["SELECT", "  id,", "  name", "FROM t;"].join("\n");
    const { template } = infer(sql);
    expect(template.style.commas.style).toBe("trailing");
  });

  it("infers leading comma style from a wrapped list", () => {
    const sql = ["SELECT", "  id", "  , name", "FROM t;"].join("\n");
    const { template } = infer(sql);
    expect(template.style.commas.style).toBe("leading");
  });

  it("infers lists.onePerLine = false when a short list stays inline", () => {
    const sql = "SELECT id, name, email FROM t;";
    const { template } = infer(sql);
    expect(template.style.lists.onePerLine).toBe(false);
  });

  it("infers booleanOperators.style = trailing when AND sits at the end of the previous line", () => {
    const sql = ["SELECT id FROM t", "WHERE a = 1 AND", "  b = 2;"].join("\n");
    const { template } = infer(sql);
    expect(template.style.booleanOperators.style).toBe("trailing");
  });

  it("infers joins.onClausePlacement = sameLine", () => {
    const sql = "SELECT a.id FROM a JOIN b ON a.id = b.id;";
    const { template } = infer(sql);
    expect(template.style.joins.onClausePlacement).toBe("sameLine");
  });

  it("infers statementTerminator.alwaysAppendSemicolon from hadSemicolon", () => {
    const withSemi = infer("SELECT 1;").template.style.statementTerminator.alwaysAppendSemicolon;
    const withoutSemi = infer("SELECT 1").template.style.statementTerminator.alwaysAppendSemicolon;
    expect(withSemi).toBe(true);
    expect(withoutSemi).toBe(false);
  });

  it("infers quoting.quoteChar = double when double-quoted identifiers are present", () => {
    const sql = 'SELECT "userId" FROM "users";';
    const { template } = infer(sql);
    expect(template.style.quoting.quoteChar).toBe("double");
  });

  it("infers quoting.forceQuoteIdentifiers = true when quoting wasn't required", () => {
    const sql = 'SELECT "id" FROM "users";';
    const { template } = infer(sql);
    expect(template.style.quoting.forceQuoteIdentifiers).toBe(true);
  });

  it("defaults deliberately-deferred fields to the base template with zero confidence", () => {
    const { template } = infer("SELECT id FROM t;");
    for (const field of [
      "lists.wrapThresholdItems",
      "commas.alignAfterComma",
      "joins.multiConditionIndent",
      "booleanOperators.indentContinuation",
      "alignment.aliases",
      "alignment.assignments",
    ]) {
      expect(template.source.confidence![field]).toBe(0);
    }
    expect(template.style.lists.wrapThresholdItems).toBe(defaultTemplate.style.lists.wrapThresholdItems);
    expect(template.style.alignment.aliases).toBe(defaultTemplate.style.alignment.aliases);
  });

  it("marks source as inferred with a per-field confidence map", () => {
    const { template } = infer("SELECT id FROM t;");
    expect(template.source.type).toBe("inferred");
    expect(template.source.confidence).toBeDefined();
  });
});

describe("inferStyleTemplate (real-world fixtures)", () => {
  const riverFixtures = [
    "learning-active-users-subscriptions",
    "snowflake-plan-cycles",
    "financial-forecast-feed",
    "persona-product-activity-subscription",
  ];

  for (const name of riverFixtures) {
    it(`detects keywordAlign layout on ${name}`, () => {
      const sql = readFileSync(new URL(`./__fixtures__/${name}.sql`, import.meta.url), "utf8");
      const { template } = infer(sql);
      expect(template.style.layout.mode).toBe("keywordAlign");
      expect(template.style.casing.keywords).toBe("upper");
      expect(template.style.commas.style).toBe("trailing");
      expect(template.style.booleanOperators.style).toBe("leading");
    });
  }

  it("detects indent layout on the non-river fixture (Claude-authored, not the user's style)", () => {
    const sql = readFileSync(new URL("./__fixtures__/daily-status-unpivot.sql", import.meta.url), "utf8");
    const { template } = infer(sql);
    expect(template.style.layout.mode).toBe("indent");
  });
});

describe("inferStyleTemplate (round-trip against a known-good template)", () => {
  it("re-infers river.json's key fields from output formatted with river.json itself", () => {
    const sql = readFileSync(
      new URL("./__fixtures__/financial-forecast-feed.sql", import.meta.url),
      "utf8"
    );
    const formatted = format(sql, riverTemplate);
    const { template } = inferStyleTemplate(formatted, {
      id: "roundtrip",
      name: "Roundtrip",
      dialect: "snowflake",
      baseTemplate: defaultTemplate,
    });

    expect(template.style.layout.mode).toBe(riverTemplate.style.layout.mode);
    expect(template.style.casing.keywords).toBe(riverTemplate.style.casing.keywords);
    expect(template.style.commas.style).toBe(riverTemplate.style.commas.style);
    expect(template.style.booleanOperators.style).toBe(riverTemplate.style.booleanOperators.style);
    expect(template.style.joins.onClausePlacement).toBe(riverTemplate.style.joins.onClausePlacement);
    expect(template.style.indentation.size).toBe(riverTemplate.style.indentation.size);
    expect(template.style.indentation.char).toBe(riverTemplate.style.indentation.char);
    expect(template.style.statementTerminator.alwaysAppendSemicolon).toBe(
      riverTemplate.style.statementTerminator.alwaysAppendSemicolon
    );
  });
});
