import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CLI_ENTRY = new URL("./index.ts", import.meta.url).pathname;

function runCli(args: string[], input?: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
    input,
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function tempSqlFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sql-format-cli-test-"));
  const path = join(dir, "input.sql");
  writeFileSync(path, contents);
  return path;
}

describe("sql-format CLI", () => {
  it("formats stdin to stdout with the default bundled template", () => {
    const { stdout, status } = runCli([], "select id, name from users where active = true;");
    expect(status).toBe(0);
    expect(stdout).toBe(["SELECT", "  id,", "  name", "FROM users", "WHERE active = true;", ""].join("\n"));
  });

  it("accepts a bundled template by name", () => {
    const { stdout, status } = runCli(["--template", "compact"], "select id, name, email from users;");
    expect(status).toBe(0);
    expect(stdout).toContain("id, name, email");
  });

  it("accepts a path to a custom template file", () => {
    const { stdout, status } = runCli(
      ["--template", new URL("../../templates/compact.json", import.meta.url).pathname],
      "select id, name, email from users;"
    );
    expect(status).toBe(0);
    expect(stdout).toContain("id, name, email");
  });

  it("--write formats a file in place and prints nothing", () => {
    const file = tempSqlFile("select id, name from users;");
    const { stdout, status } = runCli(["--write", file]);
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(readFileSync(file, "utf8")).toBe(["SELECT", "  id,", "  name", "FROM users;", ""].join("\n"));
  });

  it("--write without a file argument is an error", () => {
    const { stderr, status } = runCli(["--write"], "select 1;");
    expect(status).toBe(2);
    expect(stderr).toContain("--write requires a file argument");
  });

  it("--check exits 0 and prints nothing for already-formatted input", () => {
    const formatted = ["SELECT id", "FROM users;", ""].join("\n");
    const { stdout, status } = runCli(["--check"], formatted);
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("--check exits 1 and prints nothing for unformatted input", () => {
    const { stdout, status } = runCli(["--check"], "select id, name from users;");
    expect(status).toBe(1);
    expect(stdout).toBe("");
  });

  it("--help exits 0 and prints usage", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: sql-format");
  });

  it("rejects an unknown option", () => {
    const { stderr, status } = runCli(["--bogus"], "select 1;");
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option: --bogus");
  });

  it("rejects an unknown bundled template name", () => {
    const { stderr, status } = runCli(["--template", "nonexistent"], "select 1;");
    expect(status).toBe(2);
    expect(stderr).toContain("Template not found");
  });
});

describe("sql-format infer", () => {
  it("writes an inferred style-template JSON to stdout", () => {
    const file = tempSqlFile(["SELECT id, name", "  FROM users", " WHERE active = true;", ""].join("\n"));
    const { stdout, status } = runCli(["infer", file, "--id", "jane", "--name", "Jane"]);
    expect(status).toBe(0);
    const template = JSON.parse(stdout);
    expect(template.id).toBe("jane");
    expect(template.name).toBe("Jane");
    expect(template.source.type).toBe("inferred");
    expect(template.style.layout.mode).toBe("keywordAlign");
  });

  it("defaults dialect to generic and accepts an explicit one", () => {
    const file = tempSqlFile("select id from t;");
    const generic = JSON.parse(runCli(["infer", file, "--id", "a", "--name", "A"]).stdout);
    expect(generic.dialect).toBe("generic");
    const snowflake = JSON.parse(
      runCli(["infer", file, "--id", "a", "--name", "A", "--dialect", "snowflake"]).stdout
    );
    expect(snowflake.dialect).toBe("snowflake");
  });

  it("-o writes the template to a file instead of stdout", () => {
    const file = tempSqlFile("select id from t;");
    const outDir = mkdtempSync(join(tmpdir(), "sql-format-infer-out-"));
    const outPath = join(outDir, "out.json");
    const { stdout, status } = runCli(["infer", file, "--id", "a", "--name", "A", "-o", outPath]);
    expect(status).toBe(0);
    expect(stdout).toBe("");
    const template = JSON.parse(readFileSync(outPath, "utf8"));
    expect(template.id).toBe("a");
  });

  it("prints low-confidence field warnings to stderr", () => {
    const file = tempSqlFile("select id from t;");
    const { stderr } = runCli(["infer", file, "--id", "a", "--name", "A"]);
    expect(stderr).toContain("low confidence");
  });

  it("requires --id and --name", () => {
    const file = tempSqlFile("select id from t;");
    const { stderr, status } = runCli(["infer", file]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires --id and --name");
  });

  it("requires an example file", () => {
    const { stderr, status } = runCli(["infer", "--id", "a", "--name", "A"]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires an example file");
  });

  it("errors on a missing example file", () => {
    const { stderr, status } = runCli(["infer", "/no/such/file.sql", "--id", "a", "--name", "A"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Example file not found");
  });

  it("rejects an unknown dialect", () => {
    const file = tempSqlFile("select id from t;");
    const { stderr, status } = runCli(["infer", file, "--id", "a", "--name", "A", "--dialect", "mysql"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown dialect: mysql");
  });

  it("the inferred template is directly usable to format SQL", () => {
    const file = tempSqlFile(["SELECT id, name", "  FROM users", " WHERE active = true;", ""].join("\n"));
    const outDir = mkdtempSync(join(tmpdir(), "sql-format-infer-out-"));
    const outPath = join(outDir, "out.json");
    runCli(["infer", file, "--id", "a", "--name", "A", "-o", outPath]);
    const { stdout, status } = runCli(["--template", outPath], "select id, name from users where active = true;");
    expect(status).toBe(0);
    expect(stdout).toContain("SELECT id, name");
  });
});
