import { describe, it, expect } from "vitest";
import { buildDeepCheckRequest } from "./deep-check.js";

describe("buildDeepCheckRequest", () => {
  it("uses the Opus model and includes the SQL, source, and target in the user message", () => {
    const req = buildDeepCheckRequest("SELECT 1;", "snowflake", "redshift");
    expect(req.model).toBe("claude-opus-4-8");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    expect(req.messages[0]!.content).toContain("snowflake");
    expect(req.messages[0]!.content).toContain("redshift");
    expect(req.messages[0]!.content).toContain("SELECT 1;");
  });

  it("requests structured JSON output matching the findings schema", () => {
    const req = buildDeepCheckRequest("SELECT 1;", "postgres", "sqlite");
    expect(req.output_config.format.type).toBe("json_schema");
    const schema = req.output_config.format.schema as {
      required: string[];
      properties: { findings: { items: { required: string[] } } };
    };
    expect(schema.required).toContain("findings");
    expect(schema.properties.findings.items.required).toEqual(["snippet", "message", "confidence"]);
  });

  it("system prompt instructs against inventing low-value findings", () => {
    const req = buildDeepCheckRequest("SELECT 1;", "snowflake", "postgres");
    expect(req.system).toMatch(/empty findings array/i);
    expect(req.system).toMatch(/not rewriting/i);
  });

  it("does not include a network call — is a plain, side-effect-free object", () => {
    // Structural assertion that this stays a pure builder: calling it twice
    // with the same input produces deep-equal, independently-constructed
    // objects, not a cached/mutated shared reference.
    const a = buildDeepCheckRequest("SELECT 1;", "snowflake", "redshift");
    const b = buildDeepCheckRequest("SELECT 1;", "snowflake", "redshift");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
