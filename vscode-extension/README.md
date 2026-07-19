# sql-formatter VS Code extension

Formats SQL against a personal, fine-grained style template — directly
inside VS Code. Local-first: it calls `@sql-formatter/core` in-process, in
the extension host; nothing is sent anywhere.

## Install (personal use — not published to the Marketplace)

Build once from the repo root:

```
npm install
npm run build -w core
npm run build -w vscode-extension
```

Then package and install it:

```
cd vscode-extension
npx @vscode/vsce package --no-dependencies
code --install-extension sql-formatter-vscode-0.1.0.vsix
```

`--no-dependencies` is needed because this extension pulls `@sql-formatter/core`
in via an npm workspace symlink rather than a published npm dependency — vsce
can't resolve it through the normal `npm ls` dependency walk, but since
everything is already bundled into `dist/extension.js` by esbuild at build
time, no dependency needs to ship in the `.vsix` at all.

## Use it

- **Format Document** (the standard VS Code command/keybinding, e.g.
  `Shift+Alt+F`) on a `.sql` file formats it using the configured template.
- **SQL Formatter: Infer Style From Selection** (Command Palette) — infers a
  style template from the current selection (or the whole file if nothing's
  selected), prompts for an id/name/dialect, and opens the result as a new
  JSON document. Low-confidence fields are flagged with a warning notification
  — review those by hand before relying on the generated template, same as
  the CLI's `infer` subcommand.

## Settings

`sqlFormatter.template` (string, default `"default"`) — one of the bundled
template names (`"default"`, `"compact"`, `"river"`), or an absolute /
workspace-relative path to your own style-template JSON file (see
`schema/style-template.schema.json` at the repo root). Set it per-workspace
in `.vscode/settings.json` if different projects want different styles.

## Development

```
npm run build -w vscode-extension   # typecheck + esbuild bundle to dist/
npm test -w vscode-extension        # vitest — resolveTemplate.ts and
                                     # extension.ts's activation/registration
                                     # wiring against a mocked `vscode` API
```

There's no automated test that launches a real VS Code window — see the
root [HANDOFF.md](../HANDOFF.md) ("VS Code extension built" section) for why
that was deliberately skipped in favor of mocking the `vscode` module.
Verify interactively via **Run and Debug > Run Extension** (opens an
Extension Development Host window) if you want to exercise the real UI.
