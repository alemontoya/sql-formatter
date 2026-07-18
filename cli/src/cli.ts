import { readFileSync, writeFileSync } from "node:fs";
import { format, inferStyleTemplate } from "@sql-formatter/core";
import type { StyleTemplate, Dialect } from "@sql-formatter/core";

const BUNDLED_TEMPLATES_DIR = new URL("../../templates/", import.meta.url);
const BUNDLED_TEMPLATE_NAME = /^[a-z0-9_-]+$/i;
const DIALECTS = new Set(["generic", "postgres", "snowflake", "sqlite"]);

const HELP = `Usage: sql-format [options] [file]
       sql-format infer <example-file> --id <id> --name <name> [options]

Formats a SQL file according to a style template. Reads from stdin and
writes to stdout when no file is given.

Options:
  -t, --template <name|path>  Bundled template name (default, compact) or a
                               path to a style-template JSON file. Defaults
                               to the bundled "default" template.
  -w, --write                  Overwrite the input file in place instead of
                                printing to stdout. Requires a file argument.
  -c, --check                  Exit 1 if the input isn't already formatted;
                                prints and writes nothing.
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
  file: string | null;
}

function parseArgs(argv: string[]): Args {
  let templateArg: string | null = null;
  let write = false;
  let check = false;
  let file: string | null = null;

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
      file = arg;
    }
  }

  return { templateArg, write, check, file };
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

  const { templateArg, write, check, file } = parseArgs(argv);

  if (write && !file) {
    process.stderr.write("--write requires a file argument (can't write stdin in place)\n");
    process.exit(2);
  }

  const template = loadTemplate(templateArg);
  const input = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const output = format(input, template);

  if (check) {
    process.exit(output === input ? 0 : 1);
  } else if (write) {
    writeFileSync(file as string, output);
  } else {
    process.stdout.write(output);
  }
}
