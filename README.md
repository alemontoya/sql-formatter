# sql-formatter

A local-first SQL formatter with a fine-grained, JSON style template — for
Postgres, Snowflake, SQLite, and generic SQL. Preserves every comment,
formats losslessly off a custom tokenizer (no SQL parsing library round-trip
to drop things), and supports both conventional indented layout and
"river style" keyword-alignment layout.

This is a personal tool; the CLI is the only shipped interface today (no web
UI / VS Code / DBeaver integration yet).

## Install

```
npm install
```

Run from the repo root (an npm workspace — `cli` depends on `@sql-formatter/core`
directly), not from inside `core/` or `cli/`.

## Usage

Run without building via `tsx`:

```
npx tsx cli/src/index.ts [options] [file...]
```

Or build once and use the packaged binary:

```
npm run build -w core
npm run build -w cli
npx sql-format [options] [file...]
```

### Format a single file or stdin

```
# stdin -> stdout
cat query.sql | sql-format

# file -> stdout
sql-format query.sql

# format in place
sql-format --write query.sql

# CI/pre-commit gate: exit 1 if not already formatted, no output
sql-format --check query.sql
```

### Format multiple files or a glob

`sql-format` accepts more than one file argument, and/or a glob pattern
(e.g. `**/*.sql`). With more than one file resolved, `--write` or `--check`
is required — formatting several files to stdout at once isn't supported.

```
# reformat every .sql file under migrations/, in place
sql-format --write 'migrations/*.sql'

# reformat an entire project tree, in place
sql-format --write '**/*.sql'

# explicit file list works the same way as a glob
sql-format --write a.sql b.sql c.sql

# CI gate across a whole directory: exits 1 and lists which files
# would be reformatted, without touching any of them
sql-format --check '**/*.sql'
```

Quote glob patterns so the shell doesn't expand them first — `sql-format`
does its own glob expansion (via Node's built-in `fs.globSync`), which also
lets `--check`/`--write` report back exactly which of the matched files
needed changes.

### Choose a style template

```
# bundled templates: "default" (conventional, upper keywords, one-per-line
# lists) or "compact" (minimal wrapping, lower keywords)
sql-format --template compact query.sql

# a river-style (keyword-alignment) template
sql-format --template templates/river.json query.sql

# your own style-template JSON file (see schema/style-template.schema.json)
sql-format --template ./my-style.json query.sql
```

### Learn a style from an example (`infer`)

Already have a script formatted the way you like? Generate a best-effort
style template from it instead of hand-authoring one field at a time:

```
sql-format infer example.sql --id my-style --name "My Style" -o my-style.json
```

Fields the inference engine isn't confident about are defaulted from the
bundled `default` template and listed as warnings on stderr — review those
by hand before relying on the generated template. `--dialect` (`generic`
(default), `postgres`, `snowflake`, `sqlite`) and `--description` are also
accepted; see `sql-format --help` for the full option list.

## Full option reference

```
sql-format [options] [file...]
sql-format infer <example-file> --id <id> --name <name> [options]

-t, --template <name|path>   "default" or "compact" (bundled), or a path
                              to a style-template JSON file.
-w, --write                  Overwrite the input file(s) in place.
-c, --check                  Exit 1 if any input isn't already formatted;
                              no stdout output.
-h, --help
```

Run `sql-format --help` for the complete, up-to-date help text (including
`infer`'s options).

## Development

See [HANDOFF.md](HANDOFF.md) for architecture decisions, the repo layout,
known gaps, and the history of bugs found/fixed against real SQL scripts —
useful if you're extending the formatter itself rather than just using it.
