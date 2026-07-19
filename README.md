# sql-formatter

A local-first SQL formatter with a fine-grained, JSON style template — for
Postgres, Snowflake, SQLite, and generic SQL. Preserves every comment,
formats losslessly off a custom tokenizer (no SQL parsing library round-trip
to drop things), and supports both conventional indented layout and
"river style" keyword-alignment layout.

This is a personal tool. Interfaces shipped today: a CLI (below), a web UI
([web/README.md](web/README.md)), a [VS Code extension](vscode-extension/README.md),
and [DBeaver integration](#dbeaver-integration) (below — reuses the CLI directly,
no separate plugin). The CLI also has a heuristic [query advisor](#query-advisor-advise--heuristic-suggestions-not-a-query-optimizer)
(`sql-format advise`) — suggestions only, never an automatic rewrite.

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

### Query advisor (`advise`) — heuristic suggestions, not a query optimizer

`sql-format advise` looks at a query's structure (join order, duplicate
subqueries, which columns get filtered/joined on) and prints suggestions —
**it never rewrites your file, never connects to a database, and is not a
cost-based optimizer.** It's a heuristic that flags things worth a second
look, using table/column statistics *you* supply by hand:

```
sql-format advise query.sql --stats my-stats.json
```

Without `--stats`, only structural checks that need no stats run (right
now: spotting an identical subquery repeated in a FROM/JOIN chain, which is
suggested as a CTE extraction). With `--stats`, it also flags join chains
that could plausibly be reordered smallest-table-first, and columns your
stats mark as not indexed that show up in a JOIN/WHERE condition.

A suggestion sometimes comes with a rendered preview of the rewrite — but
**only** when it's mechanically provable as equivalent to the original
(an exact-duplicate subquery extracted into a CTE, or a chain of plain
`INNER JOIN`s reordered without ever moving the base table or touching a
join whose `ON` condition is ambiguous). Anything riskier than that stays
text-only advice for you to judge — see [HANDOFF.md](HANDOFF.md)'s "Query
advisor built" section for the exact safety rules behind each suggestion
kind.

Stats live in a JSON file matching `schema/table-stats.schema.json` —
hand-populated, never collected automatically. `sql-format advise
stats-queries --dialect <dialect>` **prints** SQL for you to run yourself
against your database and paste the result back in; this tool never runs
it or connects to anything on your behalf.

```
sql-format advise stats-queries --dialect postgres
```

## Full option reference

```
sql-format [options] [file...]
sql-format infer <example-file> --id <id> --name <name> [options]
sql-format advise <file> [--stats <stats.json>] [options]
sql-format advise stats-queries --dialect <dialect>

-t, --template <name|path>   "default" or "compact" (bundled), or a path
                              to a style-template JSON file.
-w, --write                  Overwrite the input file(s) in place.
-c, --check                  Exit 1 if any input isn't already formatted;
                              no stdout output.
-h, --help
```

Run `sql-format --help` for the complete, up-to-date help text (including
`infer`'s options).

## DBeaver integration

DBeaver has a built-in "External formatter" option (Preferences > Editors >
SQL Editor > Formatting) that shells out to a command-line tool, writes the
current SQL to a temp file, runs the command with `${file}` substituted for
that temp file's path, and reads the file back — expecting it rewritten in
place. `sql-format --write <file>` already does exactly that, so DBeaver
integration is just pointing it at the built CLI; no separate plugin needed
(DBeaver plugins are Java/Eclipse-based, and a shell-out was always the plan
— see [HANDOFF.md](HANDOFF.md)'s architecture-decisions section).

1. Build once: `npm run build -w core -w cli` from the repo root.
2. In DBeaver: **Preferences > Editors > SQL Editor > Formatting**.
3. Set **Formatter** to **External**.
4. Check **Use temp file** (required — this is how `${file}` gets populated).
5. Set **Command line** to the built CLI, invoked with an explicit `node`
   path so it doesn't depend on DBeaver inheriting your shell's `PATH`:

   ```
   /absolute/path/to/node /absolute/path/to/sql-formatter/cli/dist/index.js ${file} --write --template default
   ```

   Swap `--template default` for `compact`, `river`, or a path to your own
   style-template JSON. Find your `node` path with `which node`.
6. Set a reasonable **Exec timeout** (2000ms is enough for realistic
   scripts).

Not verified against a live DBeaver install in this session (DBeaver isn't
installed on this machine) — verified instead by scripting the exact
sequence DBeaver's external formatter performs (write a temp file, run the
command, read the file back) and confirming `sql-format --write` rewrites it
correctly in place. If DBeaver's actual behavior differs from the documented
contract, the command above may need adjusting.

## Development

See [HANDOFF.md](HANDOFF.md) for architecture decisions, the repo layout,
known gaps, and the history of bugs found/fixed against real SQL scripts —
useful if you're extending the formatter itself rather than just using it.
