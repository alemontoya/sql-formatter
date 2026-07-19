# sql-formatter web UI

A single-page, local-first web UI for the SQL formatter. Runs entirely in
your browser — SQL text is never sent anywhere, there's no backend, and
formatting happens as plain in-browser JS against `@sql-formatter/core`.

Built with Vite + vanilla TypeScript. No framework: this is one page with
two tabs, not enough complexity to justify one.

## Run it

From the repo root (this is an npm workspace, `web` depends on
`@sql-formatter/core` directly — build `core` first):

```
npm install
npm run build -w core
npm run dev -w web
```

Then open the printed local URL (default `http://localhost:5173`).

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

- `Default` / `Compact` / `River` — the same bundled templates the CLI
  ships (`templates/*.json` at the repo root; the web app imports them
  directly, so it's always in sync with the CLI's bundled set).
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

## Development

See the root [HANDOFF.md](../HANDOFF.md) — search for "Web UI built" for
the full writeup of how this workspace is put together, and the top-level
"Architecture decisions" section for the local-first/no-backend reasoning
this UI depends on.
