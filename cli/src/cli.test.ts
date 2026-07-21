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

/** Creates a fresh temp directory containing one file per `files` entry
 * (key = filename, value = contents) and returns the directory path. */
function tempSqlDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sql-format-cli-multi-test-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
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

describe("sql-format CLI (multi-file / glob)", () => {
  it("a glob pattern matching multiple files without --write/--check is an error", () => {
    const dir = tempSqlDir({ "a.sql": "select a from t;", "b.sql": "select b from t;" });
    const { stderr, status } = runCli([join(dir, "*.sql")]);
    expect(status).toBe(2);
    expect(stderr).toContain("pass --write or --check");
  });

  it("--write formats every file matched by a glob pattern in place", () => {
    const dir = tempSqlDir({ "a.sql": "select   a from t;", "b.sql": "select   b from t;" });
    const { stdout, status } = runCli(["--write", join(dir, "*.sql")]);
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(readFileSync(join(dir, "a.sql"), "utf8")).toBe(["SELECT a", "FROM t;", ""].join("\n"));
    expect(readFileSync(join(dir, "b.sql"), "utf8")).toBe(["SELECT b", "FROM t;", ""].join("\n"));
  });

  it("--write accepts multiple explicit file arguments, not just a glob", () => {
    const dir = tempSqlDir({ "a.sql": "select a from t;", "b.sql": "select b from t;" });
    const { status } = runCli(["--write", join(dir, "a.sql"), join(dir, "b.sql")]);
    expect(status).toBe(0);
    expect(readFileSync(join(dir, "a.sql"), "utf8")).toContain("SELECT a");
    expect(readFileSync(join(dir, "b.sql"), "utf8")).toContain("SELECT b");
  });

  it("--check exits 0 with no output when every matched file is already formatted", () => {
    const dir = tempSqlDir({
      "a.sql": ["SELECT a", "FROM t;", ""].join("\n"),
      "b.sql": ["SELECT b", "FROM t;", ""].join("\n"),
    });
    const { stdout, stderr, status } = runCli(["--check", join(dir, "*.sql")]);
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("--check exits 1 and lists only the unformatted files on stderr", () => {
    const dir = tempSqlDir({
      "a.sql": ["SELECT a", "FROM t;", ""].join("\n"), // already formatted
      "b.sql": "select   b from t;", // not formatted
    });
    const { stderr, status } = runCli(["--check", join(dir, "*.sql")]);
    expect(status).toBe(1);
    expect(stderr).toContain(join(dir, "b.sql"));
    expect(stderr).not.toContain(join(dir, "a.sql"));
  });

  it("--check does not modify any file", () => {
    const dir = tempSqlDir({ "a.sql": "select   a from t;" });
    runCli(["--check", join(dir, "*.sql")]);
    expect(readFileSync(join(dir, "a.sql"), "utf8")).toBe("select   a from t;");
  });

  it("a glob matching exactly one file behaves like the single-file case (prints to stdout)", () => {
    const dir = tempSqlDir({ "only.sql": "select a from t;" });
    const { stdout, status } = runCli([join(dir, "*.sql")]);
    expect(status).toBe(0);
    expect(stdout).toBe(["SELECT a", "FROM t;", ""].join("\n"));
  });

  it("a glob pattern matching no files is an error", () => {
    const dir = tempSqlDir({});
    const { stderr, status } = runCli(["--write", join(dir, "*.sql")]);
    expect(status).toBe(2);
    expect(stderr).toContain("No files matched");
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

function tempJsonFile(data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "sql-format-advise-stats-"));
  const path = join(dir, "stats.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe("sql-format advise", () => {
  it("prints structural suggestions with no --stats given", () => {
    const file = tempSqlFile(
      [
        "SELECT a.n, b.n",
        "FROM (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status = 'paid' GROUP BY customer_id) a",
        "JOIN (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status = 'paid' GROUP BY customer_id) b",
        "  ON a.customer_id = b.customer_id;",
      ].join("\n"),
    );
    const { stdout, status } = runCli(["advise", file]);
    expect(status).toBe(0);
    expect(stdout).toContain("duplicate-subquery-cte");
    expect(stdout).toContain("Preview:");
  });

  it("says so when there's nothing to suggest and no --stats was given", () => {
    const file = tempSqlFile("select id from t where active = true;");
    const { stdout, status } = runCli(["advise", file]);
    expect(status).toBe(0);
    expect(stdout).toContain("structural checks only");
  });

  it("runs join-order and unindexed-column checks when --stats is given", () => {
    const file = tempSqlFile(
      [
        "SELECT o.id, oi.sku, c.name",
        "FROM orders o",
        "JOIN order_items oi ON o.id = oi.order_id",
        "JOIN customers c ON o.customer_id = c.id",
        "WHERE c.email = 'x@example.com';",
      ].join("\n"),
    );
    const statsFile = tempJsonFile({
      id: "test",
      dialect: "generic",
      collectedAt: "2026-01-01T00:00:00Z",
      tables: {
        orders: { rowCount: 4_000_000 },
        customers: { rowCount: 500, columns: { email: { indexed: false } } },
        order_items: { rowCount: 10_000_000 },
      },
    });
    const { stdout, status } = runCli(["advise", file, "--stats", statsFile]);
    expect(status).toBe(0);
    expect(stdout).toContain("join-order");
    expect(stdout).toContain("unindexed-column");
    expect(stdout).toContain("customers.email");
  });

  it("errors on a missing SQL file", () => {
    const { stderr, status } = runCli(["advise", "/no/such/file.sql"]);
    expect(status).toBe(2);
    expect(stderr).toContain("File not found");
  });

  it("errors on a missing stats file", () => {
    const file = tempSqlFile("select 1;");
    const { stderr, status } = runCli(["advise", file, "--stats", "/no/such/stats.json"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Stats file not found");
  });

  it("requires a file argument", () => {
    const { stderr, status } = runCli(["advise"]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires a file");
  });
});

describe("sql-format advise stats-queries", () => {
  it(
    "prints dialect-specific SQL for each supported dialect",
    () => {
      for (const dialect of ["postgres", "redshift", "snowflake", "sqlite", "generic"]) {
        const { stdout, status } = runCli(["advise", "stats-queries", "--dialect", dialect]);
        expect(status).toBe(0);
        expect(stdout.length).toBeGreaterThan(0);
      }
    },
    // Four sequential `npx tsx` cold-start spawns comfortably exceed the 5s default.
    20_000,
  );

  it("requires --dialect", () => {
    const { stderr, status } = runCli(["advise", "stats-queries"]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires --dialect");
  });

  it("rejects an unknown dialect", () => {
    const { stderr, status } = runCli(["advise", "stats-queries", "--dialect", "mysql"]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires --dialect");
  });
});

describe("sql-format lint", () => {
  it("prints findings with a nonzero exit code when the target lacks a construct", () => {
    const file = tempSqlFile("select id, row_number() over (order by id) as rn from t qualify rn = 1;");
    const { stdout, status } = runCli(["lint", file, "--source", "snowflake", "--target", "redshift"]);
    expect(status).toBe(1);
    expect(stdout).toContain("snowflake-qualify");
    expect(stdout).toContain("line 1");
  });

  it("says so and exits 0 when there are no findings", () => {
    const file = tempSqlFile("select id from t where active = true;");
    const { stdout, status } = runCli(["lint", file, "--source", "snowflake", "--target", "redshift"]);
    expect(status).toBe(0);
    expect(stdout).toContain("No portability findings");
  });

  it("errors on a missing SQL file", () => {
    const { stderr, status } = runCli(["lint", "/no/such/file.sql", "--source", "postgres", "--target", "sqlite"]);
    expect(status).toBe(2);
    expect(stderr).toContain("File not found");
  });

  it("requires a file argument", () => {
    const { stderr, status } = runCli(["lint", "--source", "postgres", "--target", "sqlite"]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires a file");
  });

  it("requires --source and --target", () => {
    const file = tempSqlFile("select 1;");
    const { stderr, status } = runCli(["lint", file]);
    expect(status).toBe(2);
    expect(stderr).toContain("requires --source and --target");
  });

  it("rejects an unknown dialect", () => {
    const file = tempSqlFile("select 1;");
    const { stderr, status } = runCli(["lint", file, "--source", "mysql", "--target", "sqlite"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown dialect");
  });
});
