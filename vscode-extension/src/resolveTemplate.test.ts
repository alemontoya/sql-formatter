import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplate } from "./resolveTemplate.js";
import { BUNDLED_TEMPLATES } from "./templates.js";

describe("resolveTemplate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("resolves each bundled template name", () => {
    expect(resolveTemplate("default", undefined)).toBe(BUNDLED_TEMPLATES.default);
    expect(resolveTemplate("compact", undefined)).toBe(BUNDLED_TEMPLATES.compact);
    expect(resolveTemplate("river", undefined)).toBe(BUNDLED_TEMPLATES.river);
    expect(resolveTemplate("river-quoted", undefined)).toBe(BUNDLED_TEMPLATES["river-quoted"]);
  });

  it("defaults an empty/whitespace setting to the default template", () => {
    expect(resolveTemplate("", undefined)).toBe(BUNDLED_TEMPLATES.default);
    expect(resolveTemplate("   ", undefined)).toBe(BUNDLED_TEMPLATES.default);
  });

  it("loads a custom template from an absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-formatter-test-"));
    dirs.push(dir);
    const path = join(dir, "my-style.json");
    const custom = { ...BUNDLED_TEMPLATES.default, id: "my-style", name: "My Style" };
    writeFileSync(path, JSON.stringify(custom));

    const result = resolveTemplate(path, undefined);
    expect(result.id).toBe("my-style");
    expect(result.name).toBe("My Style");
  });

  it("resolves a relative path against the workspace root", () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-formatter-test-"));
    dirs.push(dir);
    const custom = { ...BUNDLED_TEMPLATES.default, id: "relative-style" };
    writeFileSync(join(dir, "style.json"), JSON.stringify(custom));

    const result = resolveTemplate("style.json", dir);
    expect(result.id).toBe("relative-style");
  });

  it("throws a descriptive error for a missing file", () => {
    expect(() => resolveTemplate("/does/not/exist.json", undefined)).toThrow(/couldn't read template/);
  });

  it("throws a descriptive error for invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-formatter-test-"));
    dirs.push(dir);
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not valid json");

    expect(() => resolveTemplate(path, undefined)).toThrow(/isn't valid JSON/);
  });

  it("treats a relative path as relative to cwd when no workspace root is given", () => {
    expect(() => resolveTemplate("nonexistent-relative.json", undefined)).toThrow(/couldn't read template/);
  });
});
