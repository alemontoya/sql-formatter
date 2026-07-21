import * as vscode from "vscode";
import { format, inferStyleTemplate, lintPortability, PORTABILITY_DIALECTS, buildDeepCheckRequest } from "@sql-formatter/core";
import type { Dialect, PortabilityDialect, DeepCheckFinding, DeepCheckResponseSchema } from "@sql-formatter/core";
import { resolveTemplate } from "./resolveTemplate.js";
import { BUNDLED_TEMPLATES } from "./templates.js";

const DIALECTS: Dialect[] = ["generic", "postgres", "snowflake", "sqlite"];
const ANTHROPIC_API_KEY_SECRET = "sqlFormatter.anthropicApiKey";

export function activate(context: vscode.ExtensionContext): void {
  const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
    { language: "sql" },
    {
      provideDocumentFormattingEdits(document) {
        const setting = vscode.workspace.getConfiguration("sqlFormatter", document.uri).get<string>("template", "default");
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        let template;
        try {
          template = resolveTemplate(setting, workspaceRoot);
        } catch (err) {
          vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
          return [];
        }

        let formatted: string;
        try {
          formatted = format(document.getText(), template);
        } catch (err) {
          vscode.window.showErrorMessage(`SQL Formatter: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }

        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        return [vscode.TextEdit.replace(fullRange, formatted)];
      },
    },
  );

  const inferCommand = vscode.commands.registerCommand("sqlFormatter.inferStyleFromSelection", () =>
    inferStyleFromSelection(),
  );

  const portabilityDiagnostics = vscode.languages.createDiagnosticCollection("sqlFormatterPortability");
  const checkPortabilityCommand = vscode.commands.registerCommand("sqlFormatter.checkPortability", () =>
    checkPortability(portabilityDiagnostics),
  );

  const deepCheckPortabilityCommand = vscode.commands.registerCommand("sqlFormatter.deepCheckPortability", () =>
    deepCheckPortability(context, portabilityDiagnostics),
  );

  const setApiKeyCommand = vscode.commands.registerCommand("sqlFormatter.setAnthropicApiKey", () =>
    setAnthropicApiKey(context),
  );

  context.subscriptions.push(
    formattingProvider,
    inferCommand,
    checkPortabilityCommand,
    deepCheckPortabilityCommand,
    setApiKeyCommand,
    portabilityDiagnostics,
  );
}

export function deactivate(): void {}

async function inferStyleFromSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("SQL Formatter: open a SQL file first.");
    return;
  }
  const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  if (!sql.trim()) {
    vscode.window.showErrorMessage("SQL Formatter: nothing to infer from — select some SQL or open a non-empty file.");
    return;
  }

  const id = await vscode.window.showInputBox({ prompt: "Template id", placeHolder: "jane-default" });
  if (!id) return;
  const name = await vscode.window.showInputBox({ prompt: "Template name", placeHolder: "Jane's style" });
  if (!name) return;
  const dialect = await vscode.window.showQuickPick(DIALECTS, { placeHolder: "Dialect" });
  if (!dialect) return;

  let result;
  try {
    result = inferStyleTemplate(sql, { id, name, dialect: dialect as Dialect, baseTemplate: BUNDLED_TEMPLATES.default });
  } catch (err) {
    vscode.window.showErrorMessage(`SQL Formatter: inference failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (result.warnings.length > 0) {
    vscode.window.showWarningMessage(
      `SQL Formatter: ${result.warnings.length} low-confidence field(s) defaulted — review the generated template. See Output for details.`,
    );
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "json",
    content: JSON.stringify(result.template, null, 2),
  });
  await vscode.window.showTextDocument(doc);
}

/**
 * Heuristic portability check — NOT a verified compatibility matrix or a
 * rewriter. Flags source-dialect constructs with no clean target-dialect
 * equivalent as warnings in the editor/Problems panel; never edits the file.
 */
async function checkPortability(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("SQL Formatter: open a SQL file first.");
    return;
  }

  const source = await vscode.window.showQuickPick(PORTABILITY_DIALECTS, {
    placeHolder: "Source dialect (what this file is written in)",
  });
  if (!source) return;
  const target = await vscode.window.showQuickPick(PORTABILITY_DIALECTS, {
    placeHolder: "Target dialect (what you're porting to)",
  });
  if (!target) return;

  const { findings } = lintPortability(editor.document.getText(), source as PortabilityDialect, target as PortabilityDialect);

  const diags = findings.map((f) => {
    const line = f.line - 1;
    const lineLength = editor.document.lineAt(line).text.length;
    const range = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lineLength));
    const diagnostic = new vscode.Diagnostic(range, f.message, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = "sql-formatter portability";
    diagnostic.code = f.id;
    return diagnostic;
  });

  diagnostics.set(editor.document.uri, diags);

  if (diags.length === 0) {
    vscode.window.showInformationMessage(`SQL Formatter: no portability findings for ${source} -> ${target}.`);
  } else {
    vscode.window.showWarningMessage(
      `SQL Formatter: ${diags.length} portability finding(s) for ${source} -> ${target} — see Problems panel.`,
    );
  }
}

async function setAnthropicApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Anthropic API key (stored securely via VS Code SecretStorage, never written to settings.json)",
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) return;
  await context.secrets.store(ANTHROPIC_API_KEY_SECRET, key);
  vscode.window.showInformationMessage("SQL Formatter: Anthropic API key saved.");
}

/**
 * LLM-backed portability review — an explicit, opt-in exception to this
 * extension's local-first default. Sends the file's SQL to the Claude API.
 * Findings are unverified model output, not a rewriter or compatibility
 * matrix; surfaced as Information-severity diagnostics distinct from the
 * deterministic checkPortability warnings.
 */
async function deepCheckPortability(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("SQL Formatter: open a SQL file first.");
    return;
  }

  let apiKey = await context.secrets.get(ANTHROPIC_API_KEY_SECRET);
  if (!apiKey) {
    const proceed = await vscode.window.showInformationMessage(
      "SQL Formatter: Deep Check sends this file's SQL to the Claude API. No Anthropic API key is saved yet — set one now?",
      "Set API Key",
      "Cancel",
    );
    if (proceed !== "Set API Key") return;
    await setAnthropicApiKey(context);
    apiKey = await context.secrets.get(ANTHROPIC_API_KEY_SECRET);
    if (!apiKey) return;
  }

  const source = await vscode.window.showQuickPick(PORTABILITY_DIALECTS, {
    placeHolder: "Source dialect (what this file is written in)",
  });
  if (!source) return;
  const target = await vscode.window.showQuickPick(PORTABILITY_DIALECTS, {
    placeHolder: "Target dialect (what you're porting to)",
  });
  if (!target) return;

  const sql = editor.document.getText();
  let findings: DeepCheckFinding[];
  try {
    findings = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "SQL Formatter: running deep check…" },
      async () => {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey });
        const request = buildDeepCheckRequest(sql, source as PortabilityDialect, target as PortabilityDialect);
        const response = await client.messages.create(request);
        const block = response.content[0];
        if (!block || block.type !== "text") {
          throw new Error("Deep check response did not contain a text block.");
        }
        const parsed = JSON.parse(block.text) as DeepCheckResponseSchema;
        return parsed.findings;
      },
    );
  } catch (err) {
    vscode.window.showErrorMessage(`SQL Formatter: deep check failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const diags = findings.map((f) => {
    const offset = sql.indexOf(f.snippet);
    const range =
      offset >= 0
        ? new vscode.Range(editor.document.positionAt(offset), editor.document.positionAt(offset + f.snippet.length))
        : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const diagnostic = new vscode.Diagnostic(
      range,
      `[Deep Check, ${f.confidence} confidence, unverified — review by hand] ${f.message}`,
      vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = "sql-formatter deep check";
    return diagnostic;
  });

  diagnostics.set(editor.document.uri, [...(diagnostics.get(editor.document.uri) ?? []), ...diags]);

  if (diags.length === 0) {
    vscode.window.showInformationMessage(`SQL Formatter: deep check found no additional findings for ${source} -> ${target}.`);
  } else {
    vscode.window.showWarningMessage(
      `SQL Formatter: deep check found ${diags.length} additional finding(s) for ${source} -> ${target} (unverified — see Problems panel).`,
    );
  }
}
