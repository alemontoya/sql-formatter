# sql-formatter web UI

A single-page, local-first web UI for the SQL formatter. Runs entirely in
your browser — SQL text is never sent anywhere, there's no backend, and
formatting happens as plain in-browser JS against `@sql-formatter/core`.

Built with Vite + vanilla TypeScript. No framework: this is one page with
three tabs, not enough complexity to justify one.

## Run it

From the repo root (this is an npm workspace, `web` depends on
`@sql-formatter/core` directly — build `core` first):

```
npm install
npm run build -w core
npm run dev -w web
```

Then open the printed local URL (default `http://localhost:5173`).

On Windows, `start-web-ui.bat` (repo root) does this in one double-click —
builds `core` if it hasn't been built yet, starts the dev server, and opens
your default browser to it automatically. Close its console window to stop
the server. On Linux/macOS, `start-web-ui.sh` (repo root) does the same —
run it from a terminal (`./start-web-ui.sh`) or double-click it if your file
manager is set to launch executable scripts. Ctrl+C in the terminal stops
the server.

## Build

```
npm run build -w web
```

Output goes to `web/dist/`. `npm run preview -w web` serves that build
locally. There's deliberately no public deploy step — this stays
local-only (dev server / `--host` for LAN access / a personal VPN for
remote access), see [HANDOFF.md](../HANDOFF.md)'s "Deploy/hosting decided
against" section for why.

## Using it

**Format tab** — paste SQL on the left, get formatted output on the right,
live as you type. Pick a template from the dropdown:

- `Default` / `Compact` / `River` / `River (quoted identifiers)` — the
  same bundled templates the CLI ships (`templates/*.json` at the repo
  root; the web app imports them directly, so it's always in sync with the
  CLI's bundled set). `River (quoted identifiers)` also auto-adds
  `AS <name>` to a bare `SELECT` column with no alias yet (e.g. `my_col` ->
  `my_col AS my_col`) via `aliasing.autoAliasBareColumns` — see
  `schema/style-template.schema.json` for the field, and note it only
  names plain column references, never a function call or expression.
- `Custom` — upload your own style-template JSON (see
  `schema/style-template.schema.json`), or apply one produced by the Infer
  tab below. Custom templates are saved to `localStorage` (up to 20, most
  recent first) so they, and whichever template was active, survive a page
  reload. Use "Delete saved template" to remove one.

A theme toggle (🌙/☀️) in the top-right switches between dark and light —
defaults to your OS preference, and remembers an explicit choice in
`localStorage` across reloads.

**Infer style from example tab** — already have a script formatted the way
you like? Paste it in, fill in an id/name/dialect, and click "Infer style"
to get a best-effort style-template JSON back, the same way `sql-format
infer` works on the CLI. Fields the inference engine isn't confident about
are listed as warnings below the output — review those by hand. Click "Use
this template" to apply the result to the Format tab and immediately see
your own example reformatted through the template just inferred from it —
the fastest way to check the inference actually captured your style.

**Advise tab** — heuristic query suggestions, the same engine behind
`sql-format advise` on the CLI. **Not a query optimizer and never connects
to a database** — paste SQL, optionally upload a table-stats JSON file (see
`schema/table-stats.schema.json`), and click "Run advisor". Without stats,
only structural checks run (spotting an identical subquery repeated in a
FROM/JOIN chain, suggested as a CTE extraction). With stats, it also flags
join chains that could plausibly be reordered smallest-table-first and
columns your stats mark as not indexed that show up in a JOIN/WHERE. A
suggestion only comes with a rendered preview when the rewrite is
mechanically provable as equivalent to the original — everything else is
text-only advice for you to judge. See the root [HANDOFF.md](../HANDOFF.md)'s
"Query advisor built" section for the exact safety rules behind each
suggestion kind.

Don't have a stats file yet? Pick a dialect and click "Show query" to see
the same ready-to-run SQL the CLI's `advise stats-queries` prints — copy
it, run it yourself against your database, and paste the JSON result back
under a `"tables"` key in a stats file you upload above.

**Portability tab** — heuristic dialect-portability check, the same engine
behind `sql-format lint` on the CLI. **Not a verified compatibility matrix
and never rewrites anything** — pick a source and target dialect
(`postgres`/`snowflake`/`sqlite`/`redshift`), paste SQL written for the
source dialect, and click "Check portability". Each finding names the
construct, its source line, and why it has no clean equivalent in the
target — e.g. Snowflake's `QUALIFY` clause has nothing to translate to on
Redshift/Postgres/SQLite. Dialect support evolves, so treat findings as a
starting point to verify against your target's current docs, not a final
answer.

"Deep check (Claude API)" on the same tab is the one control in this app
that isn't local-only: it sends your pasted SQL directly to the Claude API
for a second, LLM-backed opinion, on top of (not instead of) the
deterministic findings above. Click "Set API key" to save a personal
Anthropic API key — stored only in this browser's `localStorage`, never
sent anywhere except to the Claude API when you click "Deep check". The
first time you click "Deep check" without a key saved, a confirmation
prompt discloses that your SQL is about to be sent to the API before
anything happens. Findings appear in their own section, labeled
"LLM-generated, unverified — review by hand" — same treatment as the
`--deep` CLI flag and the VS Code "Deep Check Portability" command.

## Development

See the root [HANDOFF.md](../HANDOFF.md) — search for "Web UI built" for
the full writeup of how this workspace is put together, and the top-level
"Architecture decisions" section for the local-first/no-backend reasoning
this UI depends on.
