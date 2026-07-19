import { readFileSync, writeFileSync, globSync } from "node:fs";
import { format, inferStyleTemplate } from "@sql-formatter/core";
import type { StyleTemplate, Dialect } from "@sql-formatter/core";

const BUNDLED_TEMPLATES_DIR = new URL("../../templates/", import.meta.url);
const BUNDLED_TEMPLATE_NAME = /^[a-z0-9_-]+$/i;
const DIALECTS = new Set(["generic", "postgres", "snowflake", "sqlite"]);
const GLOB_CHARS = /[*?[\]{}]/;

const HELP = `Usage: sql-format [options] [file...]
       sql-format infer <example-file> --id <id> --name <name> [options]

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

export function run(argv: string[]): void {
  if (argv[0] === "infer") {
    runInfer(argv.slice(1));
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
