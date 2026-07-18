import { readFileSync, writeFileSync } from "node:fs";
import { format } from "@sql-formatter/core";
import type { StyleTemplate } from "@sql-formatter/core";

const BUNDLED_TEMPLATES_DIR = new URL("../../templates/", import.meta.url);
const BUNDLED_TEMPLATE_NAME = /^[a-z0-9_-]+$/i;

const HELP = `Usage: sql-format [options] [file]

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

export function run(argv: string[]): void {
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
