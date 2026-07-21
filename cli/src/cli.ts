import { readFileSync, writeFileSync, globSync } from "node:fs";
import { format, inferStyleTemplate, advise, STATS_QUERIES, lintPortability, PORTABILITY_DIALECTS } from "@sql-formatter/core";
import type { StyleTemplate, Dialect, TableStats, PortabilityDialect } from "@sql-formatter/core";

const BUNDLED_TEMPLATES_DIR = new URL("../../templates/", import.meta.url);
const BUNDLED_TEMPLATE_NAME = /^[a-z0-9_-]+$/i;
const DIALECTS = new Set(["generic", "postgres", "snowflake", "sqlite"]);
const PORTABILITY_DIALECT_SET = new Set<string>(PORTABILITY_DIALECTS);
const GLOB_CHARS = /[*?[\]{}]/;

const HELP = `Usage: sql-format [options] [file...]
       sql-format infer <example-file> --id <id> --name <name> [options]
       sql-format advise <file> [--stats <stats.json>] [options]
       sql-format advise stats-queries --dialect <dialect>
       sql-format lint <file> --source <dialect> --target <dialect>

Formats a SQL file according to a style template. Reads from stdin and
writes to stdout when no file is given. Accepts multiple files and/or glob
patterns (e.g. "migrations/*.sql", "**/*.sql") — with more than one file
resolved, --write or --check is required (formatting several files to
stdout at once isn't supported).

Options:
  -t, --template <name|path>  Bundled template name (default, compact) or a
                               path to a style-template JSON file. Defaults
                               to the bundled "default" template.
  -w, --write                  Overwrite the input file(s) in place instead
                                of printing to stdout. Requires a file/glob
                                argument.
  -c, --check                  Exit 1 if any input isn't already formatted;
                                prints and writes nothing (lists unformatted
                                files on stderr when checking more than one).
  -h, --help                   Show this help text.

sql-format infer: reads a SQL example (a script already formatted in your
own style) and writes a best-effort style-template JSON to stdout, so you
don't have to fill out every field of the schema by hand. Fields it isn't
confident about are defaulted from the bundled "default" template and
listed as warnings on stderr — review those by hand.

  <example-file>                Required. The SQL file to learn a style from.
  --id <id>                     Required. Template id, e.g. "jane-default".
  --name <name>                 Required. Human-readable template name.
  --dialect <dialect>            "generic" (default), "postgres", "snowflake",
                                 or "sqlite".
  --description <text>           Optional template description.
  -o, --output <path>            Write the template JSON to a file instead
                                  of stdout.

sql-format advise: a heuristic, structural query advisor — NOT a real
cost-based optimizer, and it never connects to a database. Reads a SQL
file and prints suggestions (duplicate-subquery-to-CTE, join reordering,
unindexed-column flags) against a hand-populated table-stats JSON file
(see schema/table-stats.schema.json). A rewritten preview is only printed
when the rewrite is mechanically provable as equivalent to the original —
otherwise it's advisory text only, for you to judge.

  <file>                         Required. The SQL file to analyze.
  --stats <path>                 Path to a table-stats JSON file. Without
                                  it, only structural suggestions that need
                                  no stats (duplicate-subquery-to-CTE) run.
  -t, --template <name|path>     Template used to render preview rewrites.
                                  Defaults to "default".

sql-format advise stats-queries: prints SQL you can run yourself against
your database to help populate a stats file — this tool never runs it for
you or connects to any database itself.

  --dialect <dialect>             Required. "postgres", "redshift",
                                  "snowflake", "sqlite", or "generic".

sql-format lint: a heuristic portability linter — flags SQL constructs with
no clean equivalent in a target dialect (e.g. Snowflake's QUALIFY when
targeting Redshift). It never rewrites anything and is NOT a verified
compatibility matrix — dialect support evolves, so treat findings as a
starting point to verify against your target's current docs.

  <file>                          Required. The SQL file to check.
  --source <dialect>              Required. Dialect the file is written in:
                                  "postgres", "snowflake", "sqlite", or
                                  "redshift".
  --target <dialect>              Required. Dialect you're porting to (same
                                  choices as --source).
`;

interface Args {
  templateArg: string | null;
  write: boolean;
  check: boolean;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  let templateArg: string | null = null;
  let write = false;
  let check = false;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-t" || arg === "--template") {
      templateArg = argv[++i] ?? null;
    } else if (arg === "-w" || arg === "--write") {
      write = true;
    } else if (arg === "-c" || arg === "--check") {
      check = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`);
      process.exit(2);
    } else {
      files.push(arg);
    }
  }

  return { templateArg, write, check, files };
}

/** Expands each positional arg (a literal path or a glob pattern like
 * `*.sql`/`**\/*.sql`) into concrete file paths, deduplicated in
 * first-seen order. Args with no glob metacharacters are passed through
 * unexpanded even if the file doesn't exist yet — that keeps the original
 * "file not found" error (thrown later by `readFileSync`) for a plain
 * mistyped filename, rather than silently treating it as "zero matches". */
function resolveFiles(patterns: string[]): string[] {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (GLOB_CHARS.test(pattern)) {
      for (const match of globSync(pattern)) seen.add(match);
    } else {
      seen.add(pattern);
    }
  }
  return [...seen];
}

function resolveTemplatePath(templateArg: string | null): string | URL {
  if (templateArg === null) return new URL("default.json", BUNDLED_TEMPLATES_DIR);
  if (BUNDLED_TEMPLATE_NAME.test(templateArg)) return new URL(`${templateArg}.json`, BUNDLED_TEMPLATES_DIR);
  return templateArg;
}

function loadTemplate(templateArg: string | null): StyleTemplate {
  const path = resolveTemplatePath(templateArg);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StyleTemplate;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`Template not found: ${templateArg}\n`);
      process.exit(2);
    }
    throw err;
  }
}

interface InferArgs {
  exampleFile: string | null;
  id: string | null;
  name: string | null;
  dialect: Dialect;
  description: string | null;
  output: string | null;
}

function parseInferArgs(argv: string[]): InferArgs {
  let exampleFile: string | null = null;
  let id: string | null = null;
  let name: string | null = null;
  let dialect: Dialect = "generic";
  let description: string | null = null;
  let output: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") {
      id = argv[++i] ?? null;
    } else if (arg === "--name") {
      name = argv[++i] ?? null;
    } else if (arg === "--dialect") {
      const value = argv[++i] ?? "";
      if (!DIALECTS.has(value)) {
        process.stderr.write(`Unknown dialect: ${value}\n\n${HELP}`);
        process.exit(2);
      }
      dialect = value as Dialect;
    } else if (arg === "--description") {
      description = argv[++i] ?? null;
    } else if (arg === "-o" || arg === "--output") {
      output = argv[++i] ?? null;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`);
      process.exit(2);
    } else {
      exampleFile = arg;
    }
  }

  return { exampleFile, id, name, dialect, description, output };
}

function runInfer(argv: string[]): void {
  const { exampleFile, id, name, dialect, description, output } = parseInferArgs(argv);

  if (!exampleFile) {
    process.stderr.write(`sql-format infer requires an example file\n\n${HELP}`);
    process.exit(2);
  }
  if (!id || !name) {
    process.stderr.write(`sql-format infer requires --id and --name\n\n${HELP}`);
    process.exit(2);
  }

  let sql: string;
  try {
    sql = readFileSync(exampleFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`Example file not found: ${exampleFile}\n`);
      process.exit(2);
    }
    throw err;
  }

  const baseTemplate = loadTemplate("default");
  const { template, warnings } = inferStyleTemplate(sql, {
    id,
    name,
    dialect,
    description: description ?? undefined,
    baseTemplate,
  });

  const json = JSON.stringify(template, null, 2) + "\n";
  if (output) {
    writeFileSync(output, json);
  } else {
    process.stdout.write(json);
  }
  if (warnings.length > 0) {
    process.stderr.write(warnings.join("\n") + "\n");
  }
}

function runAdviseStatsQueries(argv: string[]): void {
  let dialect: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dialect") dialect = argv[++i] ?? null;
  }
  if (!dialect || !STATS_QUERIES[dialect]) {
    process.stderr.write(`sql-format advise stats-queries requires --dialect (postgres, redshift, snowflake, sqlite, generic)\n`);
    process.exit(2);
  }
  process.stdout.write(STATS_QUERIES[dialect] + "\n");
}

interface AdviseArgs {
  file: string | null;
  statsPath: string | null;
  templateArg: string | null;
}

function parseAdviseArgs(argv: string[]): AdviseArgs {
  let file: string | null = null;
  let statsPath: string | null = null;
  let templateArg: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stats") {
      statsPath = argv[++i] ?? null;
    } else if (arg === "-t" || arg === "--template") {
      templateArg = argv[++i] ?? null;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`);
      process.exit(2);
    } else {
      file = arg;
    }
  }

  return { file, statsPath, templateArg };
}

function runAdvise(argv: string[]): void {
  if (argv[0] === "stats-queries") {
    runAdviseStatsQueries(argv.slice(1));
    return;
  }

  const { file, statsPath, templateArg } = parseAdviseArgs(argv);
  if (!file) {
    process.stderr.write(`sql-format advise requires a file\n\n${HELP}`);
    process.exit(2);
  }

  let sql: string;
  try {
    sql = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`File not found: ${file}\n`);
      process.exit(2);
    }
    throw err;
  }

  let stats: TableStats | null = null;
  if (statsPath) {
    try {
      stats = JSON.parse(readFileSync(statsPath, "utf8")) as TableStats;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write(`Stats file not found: ${statsPath}\n`);
        process.exit(2);
      }
      throw err;
    }
  }

  const template = loadTemplate(templateArg);
  const { suggestions } = advise(sql, stats, template);

  if (suggestions.length === 0) {
    process.stdout.write(
      stats
        ? "No suggestions.\n"
        : "No suggestions (structural checks only — pass --stats to also check join order and indexing).\n",
    );
    return;
  }

  for (const [i, s] of suggestions.entries()) {
    process.stdout.write(`${i + 1}. [${s.kind}] (statement ${s.statementIndex + 1}) ${s.message}\n`);
    if (s.preview) {
      process.stdout.write("   Preview:\n" + s.preview.replace(/^/gm, "   ") + "\n");
    }
    process.stdout.write("\n");
  }
}

interface LintArgs {
  file: string | null;
  source: PortabilityDialect | null;
  target: PortabilityDialect | null;
}

function parseLintArgs(argv: string[]): LintArgs {
  let file: string | null = null;
  let source: PortabilityDialect | null = null;
  let target: PortabilityDialect | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[++i] ?? "";
      if (!PORTABILITY_DIALECT_SET.has(value)) {
        process.stderr.write(`Unknown dialect: ${value}\n\n${HELP}`);
        process.exit(2);
      }
      source = value as PortabilityDialect;
    } else if (arg === "--target") {
      const value = argv[++i] ?? "";
      if (!PORTABILITY_DIALECT_SET.has(value)) {
        process.stderr.write(`Unknown dialect: ${value}\n\n${HELP}`);
        process.exit(2);
      }
      target = value as PortabilityDialect;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`);
      process.exit(2);
    } else {
      file = arg;
    }
  }

  return { file, source, target };
}

function runLint(argv: string[]): void {
  const { file, source, target } = parseLintArgs(argv);
  if (!file) {
    process.stderr.write(`sql-format lint requires a file\n\n${HELP}`);
    process.exit(2);
  }
  if (!source || !target) {
    process.stderr.write(`sql-format lint requires --source and --target\n\n${HELP}`);
    process.exit(2);
  }

  let sql: string;
  try {
    sql = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`File not found: ${file}\n`);
      process.exit(2);
    }
    throw err;
  }

  const { findings } = lintPortability(sql, source, target);

  if (findings.length === 0) {
    process.stdout.write(`No portability findings for ${source} -> ${target}.\n`);
    return;
  }

  for (const [i, f] of findings.entries()) {
    process.stdout.write(`${i + 1}. [${f.id}] line ${f.line}: ${f.snippet}\n   ${f.message}\n\n`);
  }
  process.exit(1);
}

export function run(argv: string[]): void {
  if (argv[0] === "infer") {
    runInfer(argv.slice(1));
    return;
  }
  if (argv[0] === "advise") {
    runAdvise(argv.slice(1));
    return;
  }
  if (argv[0] === "lint") {
    runLint(argv.slice(1));
    return;
  }

  const { templateArg, write, check, files: patterns } = parseArgs(argv);

  if (write && patterns.length === 0) {
    process.stderr.write("--write requires a file argument (can't write stdin in place)\n");
    process.exit(2);
  }

  const template = loadTemplate(templateArg);

  if (patterns.length === 0) {
    const input = readFileSync(0, "utf8");
    const output = format(input, template);
    if (check) {
      process.exit(output === input ? 0 : 1);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  const files = resolveFiles(patterns);
  if (files.length === 0) {
    process.stderr.write(`No files matched: ${patterns.join(", ")}\n`);
    process.exit(2);
  }

  if (files.length === 1) {
    const file = files[0] as string;
    const input = readFileSync(file, "utf8");
    const output = format(input, template);
    if (check) {
      process.exit(output === input ? 0 : 1);
    } else if (write) {
      writeFileSync(file, output);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  if (!write && !check) {
    process.stderr.write(
      `${files.length} files matched — pass --write or --check (formatting multiple files to stdout isn't supported).\n`
    );
    process.exit(2);
  }

  const unformatted: string[] = [];
  for (const file of files) {
    const input = readFileSync(file, "utf8");
    const output = format(input, template);
    if (check) {
      if (output !== input) unformatted.push(file);
    } else {
      writeFileSync(file, output);
    }
  }

  if (check) {
    if (unformatted.length > 0) {
      process.stderr.write(unformatted.map((f) => `would reformat: ${f}`).join("\n") + "\n");
      process.exit(1);
    }
    process.exit(0);
  } else {
    process.stderr.write(`Formatted ${files.length} files.\n`);
  }
}
