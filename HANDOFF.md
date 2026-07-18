# SQL Formatter — Handoff

Personal SQL formatting tool. Motivation: the user never had the patience to
configure formatting rules in DBeaver (or similar tools) to match their
preferred style, so we're building a dedicated formatter instead. This is
**not** a learning project for the user — Claude does all coding/dev work;
the user drives architecture/product decisions and reviews output.

## Where things stand

The **style-template schema**, the **core formatting engine** (tokenizer +
layout/printer), and a **CLI wrapper** (`sql-format`) are built and working.
No web UI, VS Code extension, or DBeaver integration yet.

Read `templates/default.json` and `templates/compact.json` for what a style
template looks like, and skim `core/src/format.ts` top-to-bottom — it's the
15-line entry point that ties the whole pipeline together and is the fastest
way to understand the architecture.

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
- **The "format like this example" feature** (paste an already-formatted
  script, have the tool learn/replicate that style) is a planned but
  **not-yet-started** feature. Design intent: hybrid of (1) rule-based style
  inference — parse the example, diff against canonical renderings to back
  out discrete style-template parameters, deterministic — as the primary
  approach, with (2) LLM/pattern-based fallback for idiosyncratic styles that
  don't reduce to clean rules. The `style-template.schema.json`'s `source`
  field (`type: "manual" | "inferred"` + per-field `confidence`) is the hook
  for this — an inferred template should come out shaped exactly like a
  manual one.

## Repo layout

```
package.json                        — npm workspaces root: ["core", "cli"]
schema/style-template.schema.json   — JSON Schema for style templates (flat, non-per-clause — deferred per-clause overrides to a later version)
templates/default.json              — conventional readable style (uppercase keywords, one-per-line lists)
templates/compact.json              — minimal wrapping, lowercase keywords
core/src/
  index.ts             — package entry point: re-exports format() + StyleTemplate
  types.ts            — Token, Dialect types
  keywords.ts          — SQL keyword set used for casing/clause classification
  tokenizer.ts          — lossless tokenizer (concatenating all token values reproduces the exact input)
  tokenizer.test.ts     — round-trip + classification tests, incl. real-fixture regression test
  trivia.ts            — attaches comments to the token ("leaf") they belong next to (leading vs trailing)
  tree.ts              — builds a paren-nesting tree + splits top-level statements at `;`
  clauses.ts            — splits a statement's node sequence into clauses (SELECT/FROM/WHERE/JOIN/WITH/...)
  printer.ts            — the actual layout engine: casing, indentation, list-wrapping, boolean chains, CASE blocks, JOIN/CTE printing
  format.ts            — top-level `format(sql, template): string` entry point
  style-template.ts     — StyleTemplate TS type (mirrors the JSON schema) + applyCasing()
  try.ts               — dev utility: `npx tsx src/try.ts <template.json> <file.sql>` prints formatted output, not part of the build
  __fixtures__/snowflake-plan-cycles.sql — a real user script, used as a regression-test fixture (59 comments, heavy CASE/window-function usage)
  format.test.ts        — printer-level tests: exact output, idempotency, comment-count parity, balanced parens
cli/src/
  index.ts             — shebang entry point (`#!/usr/bin/env node`), just calls run(process.argv.slice(2))
  cli.ts               — the actual CLI logic (arg parsing, template resolution, stdin/file I/O), exports run() for testing
  cli.test.ts           — integration tests: spawns the CLI via `npx tsx src/index.ts` and asserts on stdout/stderr/exit code
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

`sql-format [options] [file]` — reads SQL from a file argument or stdin,
writes formatted SQL to stdout (or back to the file with `--write`).

```
-t, --template <name|path>   "default" or "compact" (bundled), or a path to
                              a style-template JSON file. Defaults to "default".
-w, --write                   Overwrite the input file in place (requires a file arg).
-c, --check                   Exit 1 if input isn't already formatted; no output.
-h, --help
```

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

- `blankLines.betweenStatements: "preserve"` falls back to `collapseToOne` —
  true preservation of original blank-line counts between statements isn't
  wired up (would need blank-line info retained through the trivia pass,
  which currently discards whitespace token content once newline-adjacency
  is determined).
- `parentheses.subqueryOpenParenSameLine: false` isn't implemented (always
  behaves as `true`, which is what both current templates use anyway, so
  there's no visible gap yet — but it'll surface once someone sets it false).
- No wrapping inside window-function `OVER(...)` clauses — they print as one
  long inline expression regardless of `lineWidth`.
- `alignment.aliases` / `alignment.assignments` aren't implemented.
- A comment attached directly to a bare `;` (rare — a comment between the
  last real token and the semicolon) would currently be dropped, since
  `splitStatements()` in `tree.ts` discards the `;` leaf entirely rather
  than checking it for attached trivia.
- `quoting.forceQuoteIdentifiers` isn't implemented (both templates have it
  `false`, so untested).

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

1. Decide on and implement true blank-line preservation, if it turns out to
   matter in practice.
2. Start on the "format like this example" style-inference feature.
3. Consider whether the CLI needs a way to format multiple files at once
   (e.g. a glob argument) — v1 only takes a single file or stdin.

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

Also confirmed working correctly with no changes needed: `USING (...)` joins
(no `ON` clause), `RECURSIVE` CTE keyword placement, chains of 3+ single-
condition joins (each stays inline per the general "no internal newline ⇒
stays on keyword's line" rule), and idempotency on multi-CTE queries.
