# SQL Formatter — Handoff

Personal SQL formatting tool. Motivation: the user never had the patience to
configure formatting rules in DBeaver (or similar tools) to match their
preferred style, so we're building a dedicated formatter instead. This is
**not** a learning project for the user — Claude does all coding/dev work;
the user drives architecture/product decisions and reviews output.

## Where things stand

The **style-template schema**, the **core formatting engine** (tokenizer +
layout/printer, including a "river style" keyword-alignment layout mode), a
**rule-based style-inference engine**, and a **CLI wrapper** (`sql-format`,
now with an `infer` subcommand) are built and working. No web UI, VS Code
extension, or DBeaver integration yet.

Read `templates/default.json`, `templates/compact.json`, and
`templates/river.json` for what a style template looks like, and skim
`core/src/format.ts` top-to-bottom — it's the 15-line entry point that ties
the whole pipeline together and is the fastest way to understand the
architecture.

The repo is an **npm workspace** (`package.json` at the root lists
`["core", "cli"]`) so `cli` can depend on `@sql-formatter/core` directly
instead of publishing it. Run `npm install` from the repo root, not inside
`core/` or `cli/`.

## Architecture decisions (with reasoning — don't re-litigate without cause)

- **Interfaces planned**: web UI, VS Code extension, DBeaver integration
  (lowest priority — DBeaver plugins are Java/Eclipse-based, so integration
  means shelling out to a compiled core binary, not in-process embedding).
- **One core, thin shells.** All interfaces call into the same TypeScript
  core rather than reimplementing formatting logic per platform.
- **Core language: TypeScript.** VS Code extensions require JS/TS natively;
  the web UI can run TS/JS directly with no compile step. Python (best SQL
  libraries) and Rust (best portability/WASM) were considered and rejected —
  the deciding factor was collapsing deployment targets, not language quality.
- **Execution model: local-first, not hosted.** The core runs locally
  (installed binary / local daemon), not as a hosted API — avoids sending
  potentially sensitive SQL scripts to a server, and avoids a hard network
  dependency for an editor tool used mid-flow.
- **Templates: hosted centrally (GitHub), synced locally**, with offline
  fallback to the last-cached version. Not yet built — currently templates
  just live in `templates/` in this repo.
- **Dialects**: postgres, snowflake, sqlite. Locked in by the user; the style
  schema's `dialect` enum is intentionally closed to these three.
- **No external SQL parsing library — custom tokenizer instead.** This was
  investigated, not assumed. `sql-formatter` (npm) is in maintenance mode,
  tokenizer-based with a fixed config surface, no AST — too rigid for our
  style template's fine-grained knobs. `node-sql-parser` has good dialect
  coverage but its `astify()`/`sqlify()` round-trip **silently drops every
  SQL comment** (verified via smoke test, all 3 dialects) and its printer
  makes its own inconsistent quoting choices. `sql-parser-cst` /
  `prettier-plugin-sql-cst` is the one library with a comment-preserving CST,
  but has zero Snowflake support and incomplete Postgres support. None of the
  three satisfy "preserve comments" + "cover our 3 dialects" simultaneously,
  so the core builds its own lossless tokenizer instead and formats directly
  off the token stream — comments/whitespace are repositioned, never
  discarded by a lossy AST round-trip.
- **The "format like this example" feature is now built** — `core/src/infer.ts`
  (`inferStyleTemplate()`) plus the CLI's `infer` subcommand. Originally
  scoped as a hybrid of (1) rule-based inference and (2) an LLM/pattern
  fallback for idiosyncratic styles; **(2) was deliberately dropped for v1**,
  decided with the user after analyzing the real fixtures (see the dated
  section below) — every real style found so far reduces to clean rules once
  the schema/printer can express it, and adding an LLM dependency would cut
  against the local-first/no-external-API principle above for no
  demonstrated benefit yet. Revisit only if a genuinely rule-resistant style
  shows up. The `style-template.schema.json`'s `source` field
  (`type: "manual" | "inferred"` + per-field `confidence`) is populated
  exactly as originally planned — one confidence score per style field, keyed
  by dotted path.
- **"River style" keyword-alignment layout** (`style.layout.mode:
  "keywordAlign"`) is a second layout algorithm alongside the original
  level-based indentation (`"indent"`), added specifically because the
  user's actual dominant SQL style (4 of 5 real fixtures) uses it and the
  original schema/printer had no way to express it at all. See the dated
  section below for the algorithm and how it was reverse-engineered from
  real examples.

## Repo layout

```
package.json                        — npm workspaces root: ["core", "cli"]
schema/style-template.schema.json   — JSON Schema for style templates (flat, non-per-clause — deferred per-clause overrides to a later version)
templates/default.json              — conventional readable style (uppercase keywords, one-per-line lists), layout.mode: "indent"
templates/compact.json              — minimal wrapping, lowercase keywords, layout.mode: "indent"
templates/river.json                — keyword-alignment ("river") style, layout.mode: "keywordAlign" — matches the user's actual dominant hand-written style
core/src/
  index.ts             — package entry point: re-exports format(), inferStyleTemplate(), StyleTemplate, InferOptions/InferResult, Dialect
  types.ts            — Token, Dialect types
  keywords.ts          — SQL keyword set used for casing/clause classification
  tokenizer.ts          — lossless tokenizer (concatenating all token values reproduces the exact input)
  tokenizer.test.ts     — round-trip + classification tests, incl. real-fixture regression test
  trivia.ts            — attaches comments to the token ("leaf") they belong next to (leading vs trailing)
  tree.ts              — builds a paren-nesting tree + splits top-level statements at `;`
  clauses.ts            — splits a statement's node sequence into clauses (SELECT/FROM/WHERE/JOIN/WITH/...)
  printer.ts            — the actual layout engine: casing, indentation, list-wrapping, boolean chains, CASE blocks, JOIN/CTE printing, and the keywordAlign ("river style") layout mode. Exports a few helpers (`classifyLeaf`, `splitTopLevelCommas`, `firstWord`, `canonicalFamilyWord`) purely so `infer.ts` can reuse them rather than re-implement the same classification logic.
  format.ts            — top-level `format(sql, template): string` entry point
  lines.ts             — `computeLines`/`lineIndexAt`/`SourceLines`: offset → line-number lookup over the original source string, shared by `format.ts` (blank-line preservation between statements) and `infer.ts` (reading source layout to infer style)
  style-template.ts     — StyleTemplate TS type (mirrors the JSON schema) + applyCasing()
  infer.ts              — `inferStyleTemplate(sql, options)`: rule-based "format like this example" — reads a SQL example's structure/whitespace and produces a best-effort StyleTemplate with per-field confidence. See the dated section below for the field-by-field approach and what's deliberately deferred.
  infer.test.ts          — synthetic per-field tests, real-fixture layout-mode detection, and a round-trip smoke check (format with river.json, then infer from that output, confirm it recovers river.json's key fields)
  try.ts               — dev utility: `npx tsx src/try.ts <template.json> <file.sql>` prints formatted output, not part of the build
  __fixtures__/ — real user scripts, used as regression-test fixtures (see the dated bug-fix sections below for what each one caught):
    snowflake-plan-cycles.sql (59 comments, heavy CASE/window-function usage) — river style
    financial-forecast-feed.sql — river style
    persona-product-activity-subscription.sql — river style
    daily-status-unpivot.sql — plain indent-style block formatting; **Claude-authored, not the user's own style** — kept only as a regression fixture for the indent-mode default template, not a style signal
    learning-active-users-subscriptions.sql — river style
  format.test.ts        — printer-level tests: exact output, idempotency, comment-count parity, balanced parens, plus a `keywordAlign layout` describe block (synthetic + all 4 river fixtures)
cli/src/
  index.ts             — shebang entry point (`#!/usr/bin/env node`), just calls run(process.argv.slice(2))
  cli.ts               — the actual CLI logic: format-mode arg parsing/template resolution/stdin/file/glob I/O (`resolveFiles()`, backed by `node:fs`'s built-in `globSync`), plus the `infer` subcommand (dispatched on `argv[0] === "infer"`, its own arg parser), exports run() for testing
  cli.test.ts           — integration tests: spawns the CLI via `npx tsx src/index.ts` and asserts on stdout/stderr/exit code, including `sql-format infer` and multi-file/glob describe blocks
```

## Environment gotchas

- This dev machine had no Node.js/npm initially. User installed nvm + Node
  LTS manually — Claude does not run `curl | bash` install scripts itself
  (falls under "executing files from untrusted sources" even with
  permission granted), so that step is always handed to the user.
- The shell used by the coding agent's Bash tool does **not** auto-source
  `~/.bashrc`, and shell state does not persist between tool calls. Every
  command needing node/npm must start with:
  ```bash
  export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"
  ```
- Install (from repo root, not inside `core/` or `cli/`): `npm install`.
- Build: `npm run build -w core` / `npm run build -w cli` (tsc). Test:
  `npx vitest run` from inside `core/` or `cli/`. All need the nvm sourcing
  above first.

## The CLI (`cli/`)

`sql-format [options] [file...]` — reads SQL from a file argument or stdin,
writes formatted SQL to stdout (or back to the file with `--write`). Accepts
multiple files and/or glob patterns (e.g. `sql-format --write '**/*.sql'`) —
see the dated section below for multi-file semantics.

```
-t, --template <name|path>   "default" or "compact" (bundled), or a path to
                              a style-template JSON file. Defaults to "default".
-w, --write                   Overwrite the input file(s) in place (requires a
                               file/glob arg).
-c, --check                   Exit 1 if any input isn't already formatted; no
                               stdout output (lists unformatted files on
                               stderr when checking more than one file).
-h, --help
```

### Multi-file / glob examples

```
# reformat every .sql file under migrations/, in place
sql-format --write 'migrations/*.sql'

# reformat an entire project tree, in place
sql-format --write '**/*.sql'

# explicit file list works the same way as a glob (same resolveFiles() path)
sql-format --write a.sql b.sql c.sql

# CI/pre-commit gate across a whole directory: exits 1 and lists which
# files would be reformatted on stderr, without touching any of them
sql-format --check '**/*.sql'
```

Quote glob patterns so the shell doesn't expand them first — `sql-format`
does its own glob expansion (`resolveFiles()` in `cli.ts`, backed by
`node:fs`'s built-in `globSync`), which also lets `--check`/`--write` report
back exactly which of the matched files needed changes. A pattern matching
exactly one file behaves identically to passing that file directly (stdout
by default); two or more matched files requires `--write` or `--check`. See
the dated "CLI multi-file/glob support" section below for the full design
rationale.

Bundled template names resolve to `templates/<name>.json` at the repo root
via a relative `import.meta.url` lookup (`resolveTemplatePath()` in
`cli.ts`) — this only works because the CLI lives inside this monorepo next
to `templates/`. If the CLI is ever packaged/published standalone, bundled
templates will need to be copied into the `cli` package (or fetched from the
planned central template repo) rather than reached via `../../templates/`.

Run without building via `npx tsx cli/src/index.ts <args>` (used by
`cli.test.ts`, which spawns the CLI as a real subprocess and asserts on
stdout/stderr/exit code rather than unit-testing `run()` in-process, since
`run()` calls `process.exit()` directly on error paths).

### `sql-format infer` (style inference)

```
sql-format infer <example-file> --id <id> --name <name> [--dialect <dialect>] [--description <text>] [-o <output.json>]
```

Reads a SQL example already formatted in your own style, runs
`inferStyleTemplate()`, and writes the resulting style-template JSON to
stdout (or `-o <path>`). Low-confidence fields (< 0.4, defaulted from the
bundled `default.json`) are listed on stderr so you know what to sanity-check
by hand before using the template for real. `--id`/`--name` are required
(everything else the schema needs); `--dialect` defaults to `"generic"`.

## Confirmed formatting rules worth knowing before touching the printer

These came from reviewing real output against the user's actual SQL style,
not from the schema alone — they're implemented as *general* printer rules,
not template-specific hacks:

1. A comment trailing a clause keyword on the same line (e.g.
   `SELECT -- banner comment`) gets folded into the clause body's leading
   comments rather than staying stuck on the keyword line, when the body
   starts on its own line anyway. See the keyword-trivia handling in
   `printStatementBody()` in `printer.ts`.
2. **A clause body that renders on a single line stays on the keyword's own
   line, regardless of `lists.onePerLine`.** E.g. `FROM users`,
   `WHERE active = true` — not wrapped onto their own line just because the
   template says lists should be one-per-line. Wrapping only earns its keep
   when there's more than one item/condition to actually separate. The user
   flagged this explicitly as core to their own SQL style and asked for it
   as a general default, not a per-template override. Implemented as: if
   `printClauseBody()`'s output has no internal newline, keep it inline.

## Known v1 gaps (deliberate scope cuts, not bugs — don't "fix" without asking)

- ~~`parentheses.subqueryOpenParenSameLine: false` isn't implemented...~~
  **Implemented** in `indent` layout mode — see the dated section below.
  Still ignored entirely in `keywordAlign` mode (unchanged, and intentional:
  the alignment column is structurally computed from `(` being glued to the
  subquery's first keyword — see the river-style section below).
- ~~No wrapping inside window-function `OVER(...)` clauses...~~ **Implemented**
  — see the dated section below. Narrower residual gap discovered while
  implementing it (not fixed, and shared with `printGroupItems`'s pre-existing
  function-call-args wrapping too — not unique to this fix): a group's
  wrap-or-not decision only measures its *own* content against `lineWidth`,
  not the full line including whatever text precedes/follows it (e.g. the
  function name before `OVER (` or an `AS alias` after `)`). A window spec
  short enough on its own can still leave the *overall* line over `lineWidth`
  if the surrounding prefix/suffix pushes it over. Confirmed still present in
  `snowflake-plan-cycles.sql` (columns with a long alias after a
  moderate-length `OVER (...)`). Properly fixing this needs the printer to
  track "how much of the line is already consumed" and thread that into every
  group's wrap decision — a real architectural change (affects
  `printGroupItems` too), out of scope for this fix; flagging rather than
  scope-creeping into it.
- ~~`alignment.aliases` / `alignment.assignments` aren't implemented...~~
  **Implemented** — see the dated section below. Still not attempted by
  `inferStyleTemplate()` (always defaulted, 0 confidence) — no real fixture
  uses either convention, so there's no source-position signal to detect it
  from; would need a genuine example before it's worth guessing at.
- ~~A comment attached directly to a bare `;`...~~ **Implemented** — see
  the dated section below, which also covers a worse bug found while fixing
  it (a same-line trailing comment on the statement's *last real token*
  could get the synthesized `;` appended inside the comment's text,
  corrupting it — not the same case as this bullet, but directly adjacent).
- ~~`quoting.forceQuoteIdentifiers` isn't implemented...~~ **Implemented** —
  see the dated section below, which also implements `quoting.quoteChar`'s
  other half (converting an *already*-quoted identifier's quote character),
  since the field was equally unimplemented and the two are naturally one
  change. Bracket-quoted identifiers (`[foo]`) still aren't tokenized as a
  single `quotedIdentifier` token (see the array-indexing bug note below),
  so converting *from* an existing bracket-quoted identifier isn't
  reachable — only *to* bracket style, for a previously-unquoted or
  double/backtick-quoted identifier.
- `lists.wrapThresholdItems`, `commas.alignAfterComma`,
  `joins.multiConditionIndent`, `booleanOperators.indentContinuation` are
  **not attempted by `inferStyleTemplate()`** (always 0 confidence, value
  copied from the base template passed in) — see the dated section below for
  why each was judged too unreliable to infer from a single example.

## A specific bug class to remember

**Don't add real SQL function names to `KEYWORDS` in `keywords.ts`**, even if
they're also used in DDL syntax — e.g. `REPLACE` (also `REPLACE(str, a, b)`),
`EXTRACT` (also `EXTRACT(field FROM ts)`), `CAST` (also `CAST(x AS type)`).
This bit us once already: `classifyLeaf()` in `printer.ts` only detects
"function call, no space before `(`" for identifier-classified tokens, so a
keyword-classified one silently gets a stray space, e.g. `REPLACE (x, y)`
instead of `REPLACE(x, y)`. If a word needs to be a clause-starter keyword
(check `CLAUSE_STARTERS` in `clauses.ts`) but is *also* commonly used as a
function, it needs special-casing in `classifyLeaf()` rather than just being
added to `KEYWORDS`.

## Suggested next steps

1. ~~Decide on and implement true blank-line preservation...~~ **Fixed.**
   See the dated section below.
2. ~~Consider whether the CLI needs a way to format multiple files at
   once...~~ **Fixed.** See the dated section below.
3. ~~Revisit `GROUP BY`/`ORDER BY`/`HAVING` alignment...~~ **Checked, no bug
   found.** See the dated section below.
4. An LLM/pattern-based fallback for `inferStyleTemplate()` was explicitly
   deferred (see the river-style/inference section below) — only worth
   picking up if a real example shows up whose style genuinely doesn't
   reduce to the rule-based fields covered so far.
5. ~~Fix the known `classifyLeaf()` bug...~~ **Fixed.** An identifier
   immediately followed by `(...)` in table-ref position (`INSERT INTO t
   (a)`, `CREATE TABLE t (a int)`, `ALTER TABLE t (...)`) was getting
   misclassified as a function call and cased with `casing.functions`
   instead of `casing.identifiers`. `classifyLeaf()` now recognizes
   table-ref position two ways: the preceding `INTO`/`TABLE` keyword still
   sitting in the same node sequence (covers `CREATE TABLE`/`ALTER TABLE`,
   which aren't recognized clause starters), or a `bodyStartsAtTableRef`
   flag `printClauseBody()` passes for `INSERT INTO`, whose keyword gets
   split off into `clause.keyword` before the body reaches `classifyLeaf`.
   Regression tests in `format.test.ts`.

## JOIN/CTE test coverage (added, with real bugs found and fixed)

Exercised the JOIN and WITH/CTE printer paths against real examples — 11 new
tests in `format.test.ts` (`describe("format (JOIN)")` /
`describe("format (WITH / CTEs)")`). This surfaced three bugs, now fixed:

1. **Multiple CTEs rendered with no comma between them** — `WITH a AS (...)
   b AS (...)` is invalid SQL. `printCtes()` split on top-level commas but
   never put them back. Fixed by re-inserting `,` before each item after the
   first in `printCtes()` (`printer.ts`).
2. **`ctes.onePerLine` was dead code** — defined in the schema, set
   differently by both templates, but never read anywhere in the printer
   (only `ctes.blankLineBetween` was). Since CTE subquery bodies are always
   forced multi-line (`printGroup`'s `isSubquery` branch), the flag had no
   observable effect for any realistic query — it only becomes visible with
   trivial non-`SELECT` CTE bodies (e.g. `VALUES`). Fixed: `printCtes()` now
   packs CTEs onto one line when `onePerLine` is false and they fit within
   `lineWidth`.
3. **Multi-condition `ON` clauses over-indented by one level.** `printJoin()`
   was adding `joins.multiConditionIndent` to the level passed into
   `printBooleanChain()`, which then *also* added its own `+1` internally
   when `booleanOperators.indentContinuation` was true — the two knobs
   stacked. `multiConditionIndent` is meant to be the sole, dedicated control
   for how far a wrapped `ON` chain indents past the join line (WHERE/HAVING
   is the only place `indentContinuation` should apply, since those clauses
   always start their chain on a fresh line). Fixed by giving
   `printBooleanChain()` an optional explicit `continuationLevel` parameter
   that `printJoin()` now always supplies, bypassing the
   `indentContinuation`-driven default.

Also confirmed working correctly with no changes needed: `USING (...)` joins
(no `ON` clause), `RECURSIVE` CTE keyword placement, chains of 3+ single-
condition joins (each stays inline per the general "no internal newline ⇒
stays on keyword's line" rule), and idempotency on multi-CTE queries.

## Bugs found formatting a real 672-line user script (fixed)

The user ran the CLI on an actual production script (Snowflake, heavy CTEs,
currency conversion, window functions — not committed to the repo; see below).
Surfaced two more bugs, now fixed, plus 4 new regression tests in
`format.test.ts`:

1. **Unary minus/plus got a spurious space before their operand** — e.g.
   `ADD_MONTHS(d, -12)` printed as `ADD_MONTHS(d, - 12)`. The printer's
   `NO_SPACE_AFTER` set never covered `-`/`+` since there was no concept of
   unary vs. binary operators — every operator got a space on both sides by
   default. Fixed by adding `isUnarySign()` in `printer.ts` (a `-`/`+` is
   unary unless it directly follows an identifier, number, string, or a
   parenthesized group — i.e. something it could plausibly be subtracting
   from) and a `Builder.suppressNextSpace()` that `printSeq` calls right
   after printing a unary sign, so the operand attaches with no gap.
2. **`SELECT DISTINCT` with a multi-column list wrapped `DISTINCT` onto its
   own line** as if it were the first list item (e.g. `SELECT\n  DISTINCT
   col_a,\n  col_b`), because `DISTINCT`/`ALL` were just ordinary tokens at
   the front of the SELECT clause body with no special handling — the list
   splitter grouped `DISTINCT` together with the first column into one
   comma-item. Fixed in `printStatementBody()`: a leading `DISTINCT`/`ALL`
   keyword is now peeled off the SELECT clause's body and appended to the
   `SELECT` keyword text itself before the (now-shorter) body is printed, so
   it always reads `SELECT DISTINCT` / `SELECT ALL` on the header line
   regardless of whether the column list wraps.

Both were caught by eyeballing the CLI's output on the real file — `npx
vitest run` alone wouldn't have caught either, since neither the synthetic
tests nor `snowflake-plan-cycles.sql` happened to exercise `SELECT DISTINCT`
with 2+ columns or a unary numeric literal inside a function call. Worth
periodically re-running the CLI against real scripts, not just `vitest run`,
since the synthetic fixture's coverage has known holes.

The user's script (originally dropped in the repo root as `fff.sql`) was, at
the user's explicit go-ahead, added as a second permanent regression fixture:
`core/src/__fixtures__/financial-forecast-feed.sql`, with its own
`describe("format (real-world fixture: financial-forecast-feed)")` block in
`format.test.ts` — comment-preservation/idempotency/balanced-parens like the
Snowflake fixture, plus two fixture-specific regression checks tied to the
bugs it caught (no space after a unary sign, `DISTINCT` never wrapping onto
its own line). It contains real business schema/column names (customer IDs,
subscription internals, discount logic) — still ask before adding another
file like it, this one just happened to get explicit sign-off.

## Bug found formatting a Snowflake LATERAL FLATTEN snippet (fixed)

The user tried a smaller script using Snowflake's named-argument syntax
(`LATERAL FLATTEN(INPUT => ..., OUTER => TRUE)`). The tokenizer had no entry
for `=>` in `MULTI_CHAR_OPERATORS` (`tokenizer.ts`), so it fell through to
single-char operator scanning and split it into separate `=` and `>` tokens
— which the printer then spaced independently, corrupting valid syntax into
`INPUT = > PARSE_JSON(...)`. Fixed by adding `"=>"` to
`MULTI_CHAR_OPERATORS`; no printer changes were needed since normal
binary-operator spacing (space on both sides) is exactly right for `=>`.
Regression tests added in both `tokenizer.test.ts` (asserts `=>` tokenizes
as one token, not `=` + `>`) and `format.test.ts`.

This is the same failure shape as the unary-minus bug: a token got treated
generically by a codepath that assumed a fixed, closed set of operators.
Worth scanning `MULTI_CHAR_OPERATORS` against real scripts before assuming
dialect-specific operators are covered — nothing currently distinguishes
"generic" from "postgres"/"snowflake"/"sqlite" operator sets, so anything
dialect-specific has to be manually added and manually noticed missing.

## Long arithmetic (+/-) chains now wrap (new feature, plus a bug it exposed)

A third real script (persona/product-activity, not committed — no explicit
go-ahead requested this time) had SELECT-list items like `IFF(...) +
IFF(...) + ... AS total_products_subscribed` — a long chain of `+`-joined
terms the user had manually broken across lines by hand. The printer had
never had any concept of wrapping a *single list item's* internal expression
— only commas (lists) and `AND`/`OR` (boolean chains) triggered wrapping —
so this rendered as one 700+ character line, blowing through `lineWidth`
(100) by 7x. This wasn't a copy/paste mistake in a template; it was a
genuinely unimplemented case, confirmed by grepping the schema for anything
resembling an "arithmetic wrap" knob (none exists).

Asked the user how it should wrap; they chose to reuse the existing
`booleanOperators` knob (`style`: leading/trailing operator placement,
`indentContinuation`) rather than invent a separate config surface for
arithmetic chains — one operator-chain-wrapping style for the whole
template, not two. Implemented by generalizing the old
`splitBooleanChain`/`printBooleanChain` pair into `splitChain`/`printChain`
(parameterized by a "what counts as a split point" predicate) in
`printer.ts`, with `isAndOr` and the new `isArithmeticOp` (a `+`/`-` that
`isUnarySign` doesn't already claim) as the two predicates. A new
`printListItem()` wraps any SELECT/GROUP BY/ORDER BY/etc. list item at
`+`/`-` boundaries once its flat rendering overflows `lineWidth` — checked
per rendered *line*, not just "does it contain a newline anywhere", since an
item can already contain a newline from an embedded comment while still
having individual lines that are far too wide (this was the first version's
bug: bailing out early on any embedded newline, matching neither the
`SELECT DISTINCT` nor the width check, and skipping the very item that most
needed wrapping).

This also exposed — and fixed — an **idempotency/comment-loss bug** in the
new-and-old chain-splitting logic: `splitChain`/`splitBooleanChain` only
ever extracted the operator token's *text* (`"AND"`, `"+"`, etc.) and threw
away the leaf node itself. A comment sitting on the *same line* as the
operator token attaches to it as a `trailingComment` (vs. a comment on its
own line, which attaches as a `leadingComment` of the following token) —
and a trailing comment on a discarded leaf silently vanished. This didn't
show up with `AND`/`OR` in any existing test (nobody writes `AND -- note`
inline), but the wrapped arithmetic-chain output itself put the comment on
the same line as `+` (`+ -- note`), so *reformatting the formatter's own
output* dropped the comment — a real idempotency violation, caught by
running the CLI's output back through itself, not by `vitest run`. Fixed by
folding a split-operator's trailing comment onto the next segment's leading
comments inside `splitChain()` before discarding the leaf, so it survives
regardless of which side of the split it happened to land on. Worth
remembering: **any code that extracts an operator token's value and drops
the node is a candidate for this same bug** if that operator can ever carry
a trailing comment.

6 new synthetic tests added to `format.test.ts` covering: wrapping over
lineWidth, not-over-wrapping short chains, and idempotency with a mid-chain
comment. The triggering script itself, at the user's go-ahead, is now a
third committed fixture:
`core/src/__fixtures__/persona-product-activity-subscription.sql`, with its
own `describe` block — same comment/idempotency/balanced-parens checks as
the other two fixtures, plus a second-reformat-pass idempotency check
(regression for the trailing-comment-on-operator bug specifically) and a
max-line-length check (regression for the arithmetic-wrap bug specifically,
tolerant of the unrelated long-function-call-with-no-split-point lines
elsewhere in the file).

## Two more bugs from a 4th real script: CASE-comment loss, group wrapping (fixed)

A script using `UNPIVOT INCLUDE NULLS (...)` and several `CASE` expressions
with section-header comments (`-- Studio`, `-- Distribution`, ...) on their
own line before a `WHEN`/`ELSE` branch surfaced two more bugs, both fixed:

1. **Comments immediately before a `WHEN`/`ELSE` keyword inside a `CASE`
   block were silently dropped** — 4 of 14 comments in the source vanished
   entirely. `printCaseBlock()` in `printer.ts` manually reconstructs each
   branch's text (`applyCasing("WHEN", ...) + " " + ...`) from scratch
   rather than going through the generic per-node leading-comment handling
   that `printSeq()` does everywhere else, so a comment attached to the
   `WHEN`/`ELSE` leaf itself as a `leadingComment` was never looked at —
   only the branch's condition/result nodes were captured, not the keyword
   leaf itself. Fixed by threading the keyword leaf through into each
   `Branch` and printing its `leadingComments` before the branch's text,
   the same way `printStatementBody()` already does for clause keywords.
2. **Parenthesized groups (function-call args, `IN (...)` lists, `UNPIVOT`
   column lists) never wrapped, at all, regardless of width** — a 39-column
   `UNPIVOT (... FOR product_stream IN (...))` list rendered as one
   giant line. Unlike clause-level lists (`SELECT`, `GROUP BY`, ...), which
   go through `printList()` and respect `lineWidth`, `printGroup()`'s
   multi-item branch just joined everything with `", "` unconditionally.
   Asked the user how to fix this, since naively reusing `printList()`
   (which respects `lists.onePerLine`, `true` in the default template) would
   have made every multi-arg function call explode onto separate lines —
   a huge, unwanted regression. Fixed with a dedicated `printGroupItems()`
   that wraps one-item-per-line **only when the flat rendering overflows
   `lineWidth`**, deliberately ignoring `lists.onePerLine`/`wrapThresholdItems`
   since those are specifically for clause-level lists, not generic groups.

14 new tests added: `describe("format (CASE)")` (comment before `WHEN`,
before `ELSE`, multiple branches, idempotency) and
`describe("format (parenthesized groups)")` (short calls/`IN` lists stay
inline, long ones wrap, idempotency). The triggering script is a fourth
committed fixture: `core/src/__fixtures__/daily-status-unpivot.sql`.

Notice the pattern across all four real scripts so far: every one has found
a bug in a codepath that either (a) never went through the shared
`printSeq`/`printList` machinery and instead hand-rolled its own text
construction (`printCaseBlock`, `printGroup`'s old inline branch), or (b)
assumed a closed/complete set of cases (`MULTI_CHAR_OPERATORS`,
`isUnarySign`'s binary/unary distinction). When extending the printer,
prefer routing new constructs through the existing comment-aware,
width-aware building blocks (`printSeq`, `printList`, `printChain`) over
writing a new special-cased renderer from scratch.

## 5th real script bug: Snowflake's semi-structured colon (fixed)

A script using `sections.value:id` (Snowflake's `col:field` syntax for
reaching into a VARIANT/JSON column, as opposed to `::` casting) printed as
`sections.value : id` — spaces on both sides. Same failure shape as the
`=>` bug: a lone `:` fell through to the tokenizer's generic single-char
operator fallback (only `::` and `:=` were in `MULTI_CHAR_OPERATORS`, so a
standalone `:` was never given special spacing treatment), and the printer's
`NO_SPACE_BEFORE`/`NO_SPACE_AFTER` sets (`printer.ts`) had no entry for it,
so default binary-operator spacing applied. Fixed by adding `":"` to both
sets, treating it like `.` (member access — no space either side). One new
test, including a nested-path case (`value:nested:field`) to confirm
consecutive single colons don't get misparsed as anything else.

## 6th real script bug: array-indexing brackets (fixed)

A script using `ARRAY_AGG(...) WITHIN GROUP (ORDER BY ...)[0]` printed the
index as `)[ 0 ]` — a stray space before `[` and spaces padding the `0`
inside it. `[`/`]` were never tokenized or spaced specially at all (verified
`[` isn't even in `SINGLE_CHAR_PUNCTUATION`, so it fell to the generic
operator fallback), so default binary-operator spacing applied uniformly —
same root cause shape as the `=>` and `:` bugs, a third instance of it.

Unlike `:`/`=>`, this one couldn't just get added to `NO_SPACE_BEFORE`
unconditionally: `[` is *also* how SQLite's bracket-quoted identifiers work
(`SELECT [col1], [legacy col] FROM t` — confirmed via `tokenizer.test.ts`'s
existing sqlite sample, which round-trips losslessly but was never actually
tokenized as a single "bracket identifier" token; it's just plain `[`,
`identifier`, `identifier`, `]` leaves that happen to concatenate back
correctly). Blanket "no space before `[`" would have glued `SELECT[col1]`
together, which is wrong. Added `isIndexBracket()` (`printer.ts`, same shape
as `isUnarySign`): `[` is array-indexing (no space before) only when it
directly follows a value — an identifier, group/closing-paren, or another
`]` for chained indexing (`arr[0][1]`) — and keeps normal spacing everywhere
else (after a keyword, comma, or nothing, i.e. the bracket-identifier case).
`[`/`]` were added unconditionally to `NO_SPACE_AFTER`/`NO_SPACE_BEFORE`
respectively, since content should hug the brackets regardless of which
case it is. 3 new synthetic tests cover indexing, chained indexing, and
confirm the bracket-identifier case didn't regress. The triggering script
is a fifth committed fixture:
`core/src/__fixtures__/learning-active-users-subscriptions.sql`.

## "River style" keyword-alignment layout + rule-based style inference (new feature)

Before starting the planned "format like this example" style-inference
feature, analyzed all 5 real fixtures to check whether the user's actual
coding style reduces to clean rules under the existing schema. Finding: 4 of
5 (`learning-active-users-subscriptions`, `snowflake-plan-cycles`,
`financial-forecast-feed`, `persona-product-activity-subscription`)
consistently use **"river style"** — clause keywords right-pad to a shared
column, e.g.:

```sql
WITH   transaction_amounts_in_cad AS
       (SELECT DISTINCT
               ...
          FROM fact_transactions AS f
          JOIN dim_currencies AS cur
            ON cur.currency_key = f.original_currency_key
```

The 5th (`daily-status-unpivot.sql`) uses plain indent-style formatting —
the user confirmed that one was Claude-authored scaffolding, not their own
style, so it's excluded as a style signal (kept only as a regression
fixture for the existing indent-mode default template).

The schema/printer had no way to express river style at all — only
level-based indentation existed. **Decided to extend the printer/schema
first, then build inference on top of a schema that could actually express
the user's real style**, rather than build inference against a schema that
could only produce an approximation.

### The alignment algorithm (reverse-engineered from real examples, not assumed)

Precisely measuring exact character columns across the 4 fixtures (see
`awk '{n=match($0,/[^ ]/); print n-1}'` used to get exact 0-indexed leading
whitespace counts, rather than eyeballing rendered text — eyeballing
markdown-rendered whitespace was actively misleading during this
investigation) established:

- Every clause keyword in a statement/subquery scope (`SELECT`, `FROM`,
  `WHERE`, `JOIN`-variants, `ON`, `AND`/`OR`, `GROUP BY`, ...) right-pads so
  a **reference word** ends at the same shared column.
- That reference word is **only the keyword's first word** — `GROUP BY`
  aligns "GROUP", not the full two-word text; `BY` just follows with one
  space, unaligned. (Initially misread one `GROUP BY` instance as human
  drift/inconsistency because it didn't fit a "whole-keyword" alignment
  hypothesis — it fit perfectly once first-word-only alignment was tried.)
- **JOIN variants and GROUP BY/HAVING/ORDER BY don't right-align their own
  first word — they borrow another clause's reference width.** Confirmed
  with `CROSS JOIN` (first word "CROSS", 5 chars) landing at the exact same
  column as `FROM` (4 chars) in a real fixture — if each keyword aligned
  independently, `CROSS JOIN` would need one less leading space than `FROM`,
  which isn't what's observed. JOIN variants always borrow `FROM`'s width;
  `GROUP BY`/`HAVING`/`ORDER BY` always borrow `WHERE`'s. This is
  `canonicalFamilyWord()` in `printer.ts`.
- The reference column itself is **computed dynamically per scope** from
  whichever clause keywords are actually present (`max` of each one's
  canonical-family-word length) — not hardcoded to `SELECT`'s width. Verified
  with a synthetic case (`DELETE FROM t WHERE id = 1 RETURNING id` —
  `RETURNING`, 9 chars, is wider than `WHERE`, so `WHERE` right-pads out
  further than its own 5 characters to match).
- The **family's first member** (the first clause with no earlier real
  clause in the same statement — usually `SELECT` or `WITH`, but could be
  `WHERE` if e.g. `DELETE FROM` precedes it) never left-pads — it's flush at
  the scope's own base column, and instead *right*-pads so whatever follows
  (a CTE name, or the first list item) lands at the same content column
  everything else uses.
- **CTE subquery bodies always move the `(` to its own fresh line** under
  the CTE name, regardless of how long the CTE name is — verified: two CTEs
  with very different name lengths in the same script both put `(` at the
  identical column, ruling out "glued inline after the name." Contrast with
  a regular clause body (SELECT/FROM/WHERE/...), which *does* glue its
  first line inline to the keyword.
- `INSERT INTO`/`UPDATE`/`DELETE FROM`/`DELETE` are **preamble lines, not
  family members** — they stay flush left and don't participate in the
  shared-column computation at all (`PREAMBLE_CLAUSES` in `printer.ts`).
  Missing this initially caused `WITH` (following `INSERT INTO x` on the
  previous line) to be wrongly left-padded as if it were a second family
  member.

### Printer implementation (`printer.ts`)

`Ctx` gained an optional `align?: { baseLevel: number; keywordEndCol: number }`.
`indentStr()` consults it when present — `content column = keywordEndCol + 2`,
plus `indentSize` per level beyond `baseLevel`, same mechanism level-based
nesting already used. Because `ctx` already threads through every print
function, setting `ctx.align` once per scope (in `printStatementBody`) makes
list items, CASE/WHEN blocks, and nested subqueries all align correctly with
no further changes needed anywhere else — this was the main reason the
change was tractable at all rather than a much larger rewrite.

Three call sites compute/consume `ctx.align`: `printStatementBody` (the
family-width computation + family-first vs. non-first padding),
`printGroup`'s subquery branch (glues `(` directly to the inner content,
computing the nested scope's own base column from `indentStr(ctx, level).length
+ 1`), and `printCtes`/`printJoin`/`printChain` (reuse the *inherited*
`keywordEndCol` from the enclosing scope for `WITH`'s CTE-name gluing, `ON`,
and `AND`/`OR` continuations, rather than recomputing).

New `templates/river.json` — `layout.mode: "keywordAlign"`, upper casing,
trailing commas, leading `AND`/`OR`, `newLine` `ON` placement,
`lists.onePerLine: false` + `wrapThresholdItems: 999` (wrap only when a list
actually overflows `lineWidth`, not unconditionally — see below for why this
mattered).

Result: reformatting all 4 real river-style fixtures with `river.json` now
round-trips essentially exactly (idempotent, all comments preserved,
balanced parens) — the only diffs from the human originals are things the
formatter is *supposed* to fix (wrapping one over-`lineWidth` line, trimming
trailing whitespace, `as`→`AS` casing, spacing `||`/`,`, and cleanly
re-aligning ~50 lines of `snowflake-plan-cycles.sql` where the human
original had drifted by a space).

Two design decisions confirmed explicitly with the user (both kept as the
default, per-file exceptions in the fixtures notwithstanding):
1. A CTE/subquery `SELECT`'s first list item glues onto the `SELECT` line
   (matches the majority of CTEs in the fixtures; one CTE in
   `financial-forecast-feed.sql` does it differently — inconsistent in the
   source itself, so the majority pattern won).
2. Short lists (`GROUP BY 1, 2`) stay inline rather than always breaking
   one-per-line — this is *why* `river.json` uses
   `onePerLine: false` + a high `wrapThresholdItems` instead of
   `onePerLine: true` like `default.json`/`compact.json`.

Bugs found and fixed while validating against the real fixtures (all had
regression tests added to `format.test.ts`'s `keywordAlign layout` describe
block):
- Padding after a clause keyword's *leading comment* used the generic
  content-column indent instead of the family-aligned padding for that
  specific keyword — a commented-out `WHERE` line in a real fixture exposed
  this (the real `WHERE` below it ended up over-indented).
- `WITH` following a preamble line (`INSERT INTO x` before it) was
  left-padded as if it were a non-first family member, instead of staying
  flush left — the `PREAMBLE_CLAUSES` fix above.
- `CROSS JOIN`/JOIN-variant alignment using their own first-word length
  instead of borrowing `FROM`'s — the `canonicalFamilyWord()` fix above.

### `core/src/infer.ts` — rule-based style inference

`inferStyleTemplate(sql, { id, name, dialect, baseTemplate, description? })`
reuses the existing pipeline directly (`tokenize` → `attachTrivia` →
`splitStatements` → `buildTree` → `splitClauses`) plus the raw `sql` string
itself — `Token.start`/`end` are offsets into that original string, so
line/column position (and things like "is this comma the last non-whitespace
thing on its line") is recoverable with no new parsing infrastructure, just
a `computeLines()`/`lineIndexAt()` helper pair in `infer.ts`.

Every categorical/boolean field goes through one shared `chooseByVote()`
helper: majority value, confidence = agreement-fraction × a sample-size
discount (`min(1, observations/3)`) — so a single data point never reads as
full confidence, and disagreement lowers it further. Casing, `layout.mode`,
comma/boolean-operator style, JOIN/CTE/subquery placement, quoting, and
blank-line conventions all use this. `indentation.size` uses a different,
more targeted signal (see below). `lineWidth` uses the max observed line
length, rounded up and clamped.

**`layout.mode` detection**: for each statement's non-first family clauses
(the family-first clause is *excluded* — it's flush-left in both layout
modes, so including it can coincidentally tie the comparison; this was a
real bug, caught on `snowflake-plan-cycles.sql` returning 0 confidence),
compare the variance of clause keywords' *start* columns (indent mode: all
equal) against the variance of their canonical-family-word *end* columns
(align mode: all equal). Lower variance wins. Robust because it's a
classification (which mode?), not an attempt to reverse-engineer the exact
alignment arithmetic from a possibly-imperfect hand-typed example.

**`indentation.size`**: raw line-to-line indent deltas are unreliable in
`keywordAlign` mode (most line-start columns are keyword-width-driven, not
multiples of a fixed unit — confirmed this mispredicted `size: 1` on a real
fixture with `layout.mode: keywordAlign`, with *full* confidence, which is
worse than being uncertain). Primary signal instead: CASE/WHEN/END nesting
always adds exactly one `indentSize` step, in *either* layout mode, so
`collectCaseIndentDeltas()` measures the indent difference between a CASE
block's `WHEN`/`ELSE` lines and its matching `END` line. Falls back to raw
line-to-line deltas only when no CASE blocks exist to anchor on, with
confidence capped much lower (0.15 vs 0.5) specifically in `keywordAlign`
mode since that fallback is known-noisy there.

**Deliberately not inferred** (0 confidence, value copied from
`baseTemplate`): `lists.wrapThresholdItems`, `commas.alignAfterComma`,
`joins.multiConditionIndent`, `booleanOperators.indentContinuation`,
`alignment.aliases`, `alignment.assignments` — either genuinely unreliable
to infer from one example, or (the `alignment.*` fields) not wired into the
printer at all yet. `clauses.inlineShortStatements` gets a narrow positive-only
signal: true only if a short multi-clause statement is directly observed on
one line; absence isn't evidence either way, so it defaults to
false/0-confidence rather than voting "false" from silence.

Two bugs found via a round-trip validation approach (format a real fixture
with `river.json`, then run inference on that output, and check it recovers
`river.json`'s own field values — validates inference against trusted
ground truth, independent of any noise in the original hand-typed
fixtures):
- **`ctes.blankLineBetween` false positive** — compared each CTE item's
  *start* line to the *next* item's *start* line, which conflates "this
  CTE's body spans 30 lines" with "there's a blank line here." A real
  fixture with zero blank lines between CTEs inferred `true` with full
  confidence. Fixed: compare the *previous* item's *end* line (its last
  leaf/closing paren) to the next item's start line.
- **`lists.wrapThresholdItems` interaction bug** — when `lists.onePerLine`
  infers `false`, blindly copying `wrapThresholdItems` from
  `default.json` (which is `1`, harmless there only because
  `onePerLine: true` already forces wrapping regardless) force-wraps *every*
  list unconditionally once paired with `onePerLine: false` — the opposite
  of what a false `onePerLine` is supposed to mean. Fixed: fall back to a
  high `wrapThresholdItems` (999, "let lineWidth alone decide") specifically
  when the inferred `onePerLine` is `false`.

**Known accuracy limitation, not a bug**: `casing.identifiers` is a single
blanket rule applied to every identifier-classified token. Real scripts
sometimes write non-keyword "pseudo-keywords" the tokenizer doesn't
recognize (e.g. `DATE_TRUNC(MONTH, ...)` — `MONTH` isn't in `KEYWORDS`, so
it's tokenized/classified as a plain identifier) in a different case than
real column/table identifiers. Majority-vote inference picks whichever case
the *real* identifiers mostly use, so these outliers get miscased on
reformat. This is a pre-existing modeling limitation of `casing.identifiers`
being a single flat rule, not something `inferStyleTemplate()` introduced —
manually authoring a template with `casing.identifiers` has the exact same
effect.

New `core/src/infer.ts` test file (`infer.test.ts`) and the CLI `infer`
subcommand (`cli.ts`, dispatched on `argv[0] === "infer"`) — see the CLI
section above.

## `blankLines.betweenStatements: "preserve"` implemented (was a known gap)

Previously fell back to `collapseToOne` unconditionally — `format.ts` only
ever joined printed statements with a fixed `"\n\n"` or `"\n"` separator, with
no path to reproduce whatever gap the original source actually had. Turned
out not to need new trivia-retention infrastructure: `Token` already carries
`start`/`end` offsets into the original `sql` string,
and `infer.ts` already had exactly this measurement (`computeLines()` +
`lineIndexAt()`, used by `inferBlankLinesBetweenStatements()` to *detect* the
prevailing convention) — it just wasn't being reused to *apply* one.

Extracted `computeLines`/`lineIndexAt`/`SourceLines` out of `infer.ts` into a
new shared `core/src/lines.ts`, imported by both `infer.ts` and `format.ts`.
`format.ts` now computes each statement-boundary's actual blank-line count
(`originalBlankLines()`: line of the previous statement's last token's end
vs. line of the next statement's first token's start, minus one, floored at
0) and joins statements with exactly that many blank lines when
`betweenStatements === "preserve"`, instead of a fixed separator.
`"collapseToOne"`/`"none"` are unaffected (still fixed 1/0 blank lines
regardless of source spacing).

The semicolon token itself isn't tracked as a leaf (`splitStatements()` in
`tree.ts` discards it, a known pre-existing gap for comment-on-bare-`;`
cases — see above), but it doesn't need to be for this: it's always on the
same source line as the previous statement's last real token in practice, so
measuring from that token's end still gets the right line-gap count.

4 new tests in `format.test.ts`'s `describe("format (blank lines between
statements)")`: `"none"` strips regardless of source spacing, `"collapseToOne"`
always inserts exactly one blank line, `"preserve"` reproduces 0/1/2 blank
lines exactly across three statement boundaries, and idempotency (reformatting
`"preserve"` output produces identical output). Verified manually against the
CLI too, including a 3-statement file with 0/1/3 blank-line gaps and a
round-trip idempotency check.

## `GROUP BY`/`HAVING`/`ORDER BY` `keywordAlign` alignment — checked, no bug found

Investigated the flagged next-step: only `GROUP BY` had real-fixture coverage
for the "borrow WHERE's alignment width" behavior (`canonicalFamilyWord()` in
`printer.ts`); `HAVING`/`ORDER BY` were unverified and untested.

**Found no bug** — re-measured the real fixture that already has `GROUP BY`
(`financial-forecast-feed.sql:59-60`, `WHERE pr.plan_family != 'Reason'` /
`GROUP BY 1, 2`) at the exact character level: both keywords start at the
identical leading column (9 spaces), even though `GROUP BY` (8 chars) is
three characters longer than `WHERE` (5). That confirms what "borrow a
width" actually means for river style: the borrower's *leading* column
matches the reference's, not a shared *content* column past the keyword —
same shape as the already-verified `CROSS JOIN`/`FROM` case. A `printer.ts`
comment near the align-mode body-gluing code (`"every other clause already
ends exactly at keywordEndCol via familyPad, so one space suffices"`) reads
as if content columns should line up, which looked like a bug for two-word
borrowers (`GROUP BY`/`ORDER BY`) or length-mismatched ones (`HAVING`, 6
chars vs. `WHERE`'s 5) until checked against the real fixture — that
comment is describing the single-word/matching-length case (`FROM`,
`WHERE` itself) correctly but doesn't generalize, and the actual behavior it
documents (shared leading column) is what's both implemented and correct.
`HAVING`/`ORDER BY` run through the identical `canonicalFamilyWord()` +
`familyPad()` codepath as `GROUP BY`, so the same verified behavior applies
to them with no special-casing needed.

Added 2 new tests to `format.test.ts`'s `keywordAlign layout` describe block
to lock this in (previously `HAVING`/`ORDER BY` had zero `keywordAlign`
coverage): one with `WHERE` present (mirrors the real fixture's exact
column arithmetic), one without `WHERE` at all (confirms `GROUP BY`/
`HAVING`/`ORDER BY` still borrow the literal `"WHERE"`-width reference and
widen `FROM` to match it, even when no actual `WHERE` clause exists to
borrow from).

## CLI multi-file/glob support added (`sql-format --write '**/*.sql'`)

Previously the CLI took exactly one file argument (or stdin) — no way to
format a whole directory/project in one invocation. `parseArgs()` in
`cli.ts` now collects every positional arg into a `files: string[]` array
instead of a single `file: string | null`, and a new `resolveFiles()`
expands each one that contains glob metacharacters (`*?[]{}`, checked with
`GLOB_CHARS`) via `node:fs`'s built-in `globSync` (stable, unflagged, as of
the Node version this repo targets — no new dependency needed), passing
plain literal paths through unexpanded so a mistyped filename still hits the
original `readFileSync` "file not found" error rather than a confusing
"zero glob matches". Results are deduplicated (a `Set`, first-seen order)
since overlapping patterns/explicit args are a realistic way to end up with
the same path twice.

`run()` branches on the resolved file count:
- **0 files** (no positional args at all): unchanged stdin behavior.
- **Exactly 1 resolved file**: byte-for-byte the original single-file
  codepath (stdout by default, `--write` writes in place, `--check` sets
  exit code) — a glob that happens to match one file is indistinguishable
  from passing that file directly, so single-file scripts/muscle-memory
  keep working exactly as before.
- **2+ resolved files**: requires `--write` or `--check` — formatting
  multiple files to stdout concatenated has no sane consumer, so it's a
  hard error (`exit 2`) telling the user to pick one of the batch modes,
  rather than silently doing something surprising. `--write` formats and
  overwrites every matched file, then prints a one-line summary count to
  stderr (`"Formatted N files."`) — the single-file `--write` path stays
  silent, so this doesn't change existing scripts that pipe/redirect single-
  file `--write` output. `--check` formats every matched file in memory
  (never writes), exits 1 if any differs from its formatted form, and lists
  just the unformatted paths on stderr (`"would reformat: <path>"` per
  line) rather than only a bare exit code — useful as a pre-commit/CI gate
  across a whole directory where you actually want to know which files
  failed, not just that "something" did.

8 new tests in `cli.test.ts`'s `sql-format CLI (multi-file / glob)` describe
block: no-flag error, `--write` via glob, `--write` via multiple explicit
file args (not just a glob — the two argument shapes share the same
`resolveFiles()` path), `--check` passing silently, `--check` failing and
naming only the actually-unformatted file, `--check` never mutating a file,
a glob matching exactly one file falling through to the single-file/stdout
path, and a glob matching zero files erroring clearly. All 19 pre-existing
CLI tests still pass unchanged, confirming the single-file/stdin paths
weren't disturbed.

## `parentheses.subqueryOpenParenSameLine: false` implemented (in `indent` mode)

Working through the "Known v1 gaps" list in order. This field was accepted
by the schema and even inferred by `inferStyleTemplate()`, but the printer
always behaved as if it were `true` — a subquery's `(` stayed glued to
whatever preceded it (`WHERE id IN (`) regardless of the setting.

`printGroup()`'s subquery detection (`firstInner` is `SELECT`/`WITH`) was
inlined and duplicated the check inline; extracted into a shared
`isSubqueryGroup()` so `printSeq()` — which is what actually decides
spacing/line breaks around a group node — can ask the same question
*before* calling `printGroup()`, not just after. `printSeq()`'s group
branch now checks: is this a subquery, are we in `indent` layout mode (not
`keywordAlign` — that mode structurally requires `(` glued to the
subquery's first keyword, since the family-alignment column is computed
from its position; unaffected, confirmed via a synthetic same-vs-false
equality test), and is `subqueryOpenParenSameLine` false? If all three,
it calls `b.newline(ctx, level)` before printing the group instead of
`b.text(...)`, moving `(` onto its own fresh line at the current level
rather than gluing it to the previous token:

```sql
-- true (default, unchanged)
WHERE id IN (
  SELECT user_id FROM orders WHERE total > 100
)

-- false (newly implemented)
WHERE id IN
(
  SELECT user_id FROM orders WHERE total > 100
)
```

`printGroup()` itself needed no change — its non-align subquery branch
already produces `"(\n" + inner + "\n" + close`; the only missing piece was
*whether a line break happens before that string is emitted*, which is a
`printSeq()`-level decision (`printGroup()` doesn't know what preceded it).
Every other `printGroup()` call site (function-call args, `IN (...)`
lists, CTE bodies in `keywordAlign` mode via `printCteItem`) routes through
`printSeq()`/`printChain()` for indent-mode groups or is align-mode-only, so
this one change point covers all of them — confirmed for CTEs specifically
(`WITH t AS (select ...)`, indent mode) since CTE items print via `printSeq`
when not in `keywordAlign` mode.

6 new tests in `format.test.ts`'s `describe("format
(parentheses.subqueryOpenParenSameLine)")`: `true` still glues (regression
guard), `false` moves `(` to its own line (exact full-output match), `false`
also applies to a CTE, `false` doesn't affect an unrelated function call's
parens, `keywordAlign` mode produces byte-identical output regardless of the
setting, and idempotency. All 126 pre-existing `core` tests still pass
unchanged (both bundled templates set this `true`, so default behavior for
anyone not touching the field is untouched). Verified manually against the
CLI too, including a CTE case and an idempotency round-trip.

## Window-function `OVER (...)` wrapping implemented

Next item on the "Known v1 gaps" list. Previously an `OVER (...)` spec's
content — `PARTITION BY`/`ORDER BY` and their column lists — was printed as
a plain paren-group comma list (whatever generic `printGroupItems()` branch
a group falls into), and since a window spec commonly has only *one*
top-level comma overall (between the last `PARTITION BY` column and the
`ORDER BY` keyword sequence, which isn't actually a comma boundary at all —
there's no comma there), `splitTopLevelCommas()` frequently found zero or
one comma and never wrapped, regardless of `lineWidth`.

Added `["PARTITION", "BY"]` to `CLAUSE_STARTERS` in `clauses.ts` (`ORDER BY`
was already there) — safe to add unconditionally since `PARTITION BY` is
never valid SQL outside a window spec's parens, and `splitClauses()` only
ever runs against one paren-nesting scope's node list, never confusing an
inner window spec's clauses with an outer statement's. New `printer.ts`
pieces: `isWindowSpecGroup()` (content starts with `PARTITION`/`ORDER`,
mirroring `isSubqueryGroup()`'s shape), `printWindowSpec()` (tries the flat
one-line rendering first; if it overflows `lineWidth`, reuses
`splitClauses()` to split into `PARTITION BY`/`ORDER BY` segments and prints
each on its own line), and `printWindowClauseList()` (wraps a segment's own
comma list one-per-line only if *it* overflows — same "ignore
`lists.onePerLine`, wrap only when needed" philosophy `printGroupItems()`
already uses for generic groups, not the clause-level list rules). Wired
into `printGroup()` alongside the existing subquery/plain-list branches.
Works identically in both layout modes — no shared alignment column is
needed inside a window spec, unlike a subquery scope, so no
`keywordAlign`-specific branch was needed here (confirmed with a test).

A frame clause (`ROWS BETWEEN ...`) has no clause-starter of its own, so it
folds into `ORDER BY`'s segment as trailing tokens rather than getting its
own line — acceptable for now (no real fixture's frame clause is long
enough to need further wrapping; see the `snowflake-plan-cycles.sql` example
in the dated section above).

6 new tests in `format.test.ts`'s `describe("format (window function OVER
(...) wrapping)")`: short spec stays inline, long spec wraps
`PARTITION BY`/`ORDER BY` (exact full-output match), a frame clause folds
into `ORDER BY`'s line, a `PARTITION BY` column list itself wraps
one-per-line when it alone overflows, `keywordAlign` mode wraps the same
way, and idempotency. All 132 `core` tests total pass (126 pre-existing +
6 new). Verified manually against real `OVER (...)` calls from
`snowflake-plan-cycles.sql` and confirmed the fixture still round-trips
idempotently after reformatting with the new wrapping active — see the
"Known v1 gaps" entry above for the narrower residual line-length gap this
surfaced (not fixed here, flagged as a separate architectural limitation).

## `alignment.aliases` / `alignment.assignments` implemented

Next item on the "Known v1 gaps" list. Both fields were schema-required but
had no printer behavior at all — set either to `true` and output was
identical to `false`. Unlike the two previous items on this list, neither
has a real fixture to verify against (`inferStyleTemplate()` never sees
enough signal to infer them, confirmed 0-confidence in all fixture runs so
far), so the target behavior here is a direct reading of the schema's own
description text (`"Align AS aliases into a column across a list"` /
`"Align = signs into a column"`), not something reverse-engineered from a
real example the way `keywordAlign`'s alignment rules were.

New shared helper `printAlignedList()` in `printer.ts`: renders a list
exactly like `printList`+`printListItem` would (same wrap-or-not decision —
`lists.onePerLine`/`wrapThresholdItems`/`lineWidth` overflow/any item
already multi-line — so alignment never changes *whether* a list wraps,
only how it looks once it does), then, only if the list actually wraps
one-per-line, finds each item's split point via a caller-supplied
`splitIndex(item)` function and pads every item's pre-split text out to the
widest one in the list. Two split-point finders: `topLevelAsIndex()` (first
top-level `AS` keyword leaf — "top-level" matters so `CAST(x AS int)`'s
nested `AS` inside the group node doesn't get picked up) for
`alignment.aliases`, and `topLevelEqualsIndex()` (first top-level `=`
operator leaf) for `alignment.assignments`. An item with no matching split
point (no alias, or — shouldn't happen in valid SQL, but handled
defensively — a `SET` item with no `=`) prints unpadded, same as without
alignment, rather than breaking the rest of the list's alignment. An item
that itself renders multi-line (its own overflow wrapping) is also excluded
from padding, since there's no single column position to align in a
multi-line item.

Wired into `printClauseBody()`: `alignment.aliases` applies to `SELECT` and
`RETURNING` (the two `LIST_CLAUSES` where `AS alias` commonly appears);
`alignment.assignments` applies to `SET` (`UPDATE ... SET col = val, ...`).
The schema description also mentions `assignments` covering "INSERT column
lists," but an `INSERT INTO t (a, b)` column list has no `=` in it at all —
that phrase is either imprecise or referring to something else entirely
(possibly a bigger, unrelated feature: aligning `VALUES` tuples column-wise
across multiple rows). Left unimplemented and flagged rather than guessed
at; `assignments` is scoped strictly to `SET`, the one unambiguous case the
description names.

Confirmed correct in both layout modes, including `keywordAlign` (alignment
computed independently of, and doesn't disturb, the family-alignment
column) — e.g. a 3-column `SELECT` with long expressions and
`alignment.aliases: true` under `river.json` wraps and aligns `AS` while
`FROM`/`WHERE` still right-pad to their own shared column normally.

9 new tests in `format.test.ts`'s `describe("format (alignment.aliases /
alignment.assignments)")`: aliases off (unchanged baseline), aliases on
(exact full-output column check), an item with no `AS` staying unpadded
without breaking the others, an inline (non-wrapped) list staying untouched
(nothing to align into), assignments on (`SET`, exact column check),
assignments not leaking into an unrelated `SELECT`'s aliases, both working
together in `keywordAlign` mode once wrapped, and idempotency for both
settings. All 141 `core` tests pass (132 pre-existing + 9 new); 168 total
across `core`+`cli`. Verified manually against the CLI too, including mixed
alias/no-alias lists and idempotency round-trips for both settings.

**Known limitation, not fixed**: alignment padding doesn't account for
`commas.style: "leading"` — a leading `", "` prefix on continuation lines
shifts those items' visible column by 2 characters relative to the first
item, which has no such prefix. Both bundled templates needing this feature
would use trailing commas in practice; flagging rather than fixing blind,
since there's no real example to confirm what the "correct" leading-comma
+ alignment interaction should even look like.

## Comments near a statement-terminating `;` — dropped/corrupted, now fixed

Next item on the "Known v1 gaps" list. Testing the documented gap (a
comment attached directly to a bare `;`) surfaced a second, worse bug in
the same neighborhood that wasn't in the original bullet:

1. **The documented gap**: `splitStatements()` in `tree.ts` finds a
   top-level `;`, uses it purely as a split signal, and discards the leaf
   — including any comments attached to it. Two shapes: a comment on its
   own line directly before the `;` (attaches as the `;` leaf's own
   `leadingComments`, per the trivia pass's "own-line comment attaches to
   the *following* token" rule), or a comment trailing the `;` on the same
   line (`trailingComment`). Both vanished entirely.
2. **Found while testing #1, not in the original bullet**: `format.ts`'s
   `if (alwaysAppendSemicolon) text += ";"` appends the `;` character
   blindly to whatever `printStatement()` produced. If the statement's own
   *last real token* has a same-line trailing `lineComment` (e.g. `select 1
   -- inline before semi\n;`), that comment is already the literal tail of
   `text` — appending `;` right after it doesn't terminate the statement,
   it lands **inside** the comment's text (`-- inline before semi;`), since
   a line comment runs to end-of-line and swallows anything appended past
   it. The semicolon effectively disappeared from the SQL's actual
   structure, not just its formatting.

Both share one root fix, applied without deep restructuring of the
printer: **a synthesized `;` must never be glued directly after a line
comment.** `splitStatements()`'s return type gained
`danglingLeadingComments`/`danglingTrailingComment` (the discarded `;`
leaf's own comments, captured instead of thrown away). A new exported
`lastLeafOfStatement()` in `printer.ts` (thin wrapper around the
already-existing but unexported `lastLeaf()`, which recurses through
groups via `.close`) lets `format.ts` check whether the statement's actual
last leaf carries a trailing `lineComment`. `format.ts` then picks the
placement:

- Normal case (no dangling comments, doesn't end in a line comment):
  `text + ";"`, byte-identical to before.
- Ends in a line comment (case 2 above), no dangling comments: `;` moves to
  a fresh line (`text + "\n;"`) — can't be repositioned earlier without
  leaf-level surgery through every print function that might emit the
  statement's last token, so a guaranteed-safe fresh line was chosen over a
  more invasive fix for a rare edge case.
- Dangling leading comments exist (comment on its own line before the
  original `;`): each printed on its own line, followed by `;` on a fresh
  line after them — closely mirrors the original source shape.
- Dangling trailing comment exists (comment on the same line as the
  original `;`): appended after the synthesized `;` on the same line
  (`text + "; " + comment`) — safe, since nothing needs to follow it on
  that line.

6 new tests in `format.test.ts`'s `describe("format (comments around a
statement-terminating semicolon)")`: the corruption case (exact output,
`;` on its own line), a leading dangling comment preserved, a trailing
dangling comment preserved, a later statement unaffected by an earlier
one's dangling comment, the normal case unchanged, and idempotency across
all three comment-near-semicolon shapes. All 147 `core` tests pass (141
pre-existing + 6 new); 174 total across `core`+`cli`. `infer.ts` destructures
only `leaves`/`hadSemicolon` from `splitStatements()`'s return value, so the
two new fields didn't require any change there. Verified manually against
the CLI for all four scenarios plus idempotency round-trips.

## `quoting.forceQuoteIdentifiers` / `quoting.quoteChar` implemented

Next item on the "Known v1 gaps" list. Neither field had any printer
behavior — `printer.ts` never read `ctx.style.quoting` at all. Both
bundled templates use `forceQuoteIdentifiers: false`/`quoteChar: "none"`,
so this was invisible until someone actually set either field.

Implemented in `renderLeafText()` (`printer.ts`), the single function every
leaf's printed text already funnels through, so no new call sites were
needed:

- **`kind === "identifier"`** (a plain, previously-unquoted identifier —
  table/column names, not function or type names, which have their own
  `casing.functions`/`casing.types` and are deliberately untouched by this
  field): casing is applied first as usual, then, if
  `forceQuoteIdentifiers` is true and `quoteChar !== "none"`, the result is
  wrapped in the target quote style via new `quoteIdentifier()`. No
  escaping is needed for this direction — a valid unquoted SQL identifier
  can only contain `[A-Za-z0-9_$]` (per the tokenizer's
  `isIdentifierPart()`), so it can never itself contain a quote character.
- **`kind === "raw"`** (the default branch — covers `token.type ===
  "quotedIdentifier"` among other non-identifier/keyword tokens): if the
  token is an already-quoted identifier and `quoteChar !== "none"`, its
  existing quote characters are stripped and doubled-quote escapes
  unescaped (new `unquoteIdentifier()`), then re-quoted in the target
  style via the same `quoteIdentifier()`. This runs independent of
  `forceQuoteIdentifiers` — an already-quoted identifier doesn't need
  "forcing," it just needs its quote *character* converted, matching the
  schema's own description ("`none` leaves existing quoting untouched",
  implying any other value **does** touch existing quoting). Casing is
  deliberately never applied on this path — quoted identifiers are
  case-sensitive in SQL, so `casing.identifiers` would silently change
  program behavior if applied here, unlike a plain identifier being
  force-quoted (which stays byte-identical to how the printer already
  cased it before this feature existed).

`quoteChar: "none"` is checked on both paths, making it a true no-op
regardless of `forceQuoteIdentifiers` — including the (contradictory,
degenerate) case of `forceQuoteIdentifiers: true` with `quoteChar: "none"`,
where there's simply no quote character to force with; treated as a no-op
rather than an error, consistent with how the rest of the printer handles
unusual-but-not-invalid field combinations.

**Known limitation, inherent to the tokenizer, not this change**: bracket-
quoted identifiers (`[foo]`) aren't tokenized as a single `quotedIdentifier`
token at all — per the array-indexing bug note above, `[`/`]` are plain
punctuation leaves, with the identifier between them a separate token. So
`quoteChar` conversion only reliably reads *from* double/backtick-quoted
source identifiers; converting *from* an existing bracket-quoted identifier
to another style isn't reachable without deeper tokenizer changes (treating
bracket-quoting as its own recognized token, which would also need to
disambiguate from array-indexing `[0]`/SQLite's identical bracket syntax —
out of scope here). Converting *to* bracket style, for a previously
unquoted or double/backtick-quoted identifier, works fine and is tested.

10 new tests in `format.test.ts`'s `describe("format
(quoting.forceQuoteIdentifiers / quoting.quoteChar)")`: unchanged default
baseline, force-quote with each of double/backtick/bracket, `quoteChar:
"none"` making `forceQuoteIdentifiers: true` a no-op, function/type names
staying unquoted, converting an existing quoted identifier's quote
character with `forceQuoteIdentifiers: false`, `quoteChar: "none"` leaving
existing quoting untouched, an existing quoted identifier keeping its
original casing regardless of `casing.identifiers`, and idempotency. All
157 `core` tests pass (147 pre-existing + 10 new); 184 total across
`core`+`cli`. Verified manually against the CLI for every combination
above plus an idempotency round-trip.
