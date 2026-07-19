import * as vscode from "vscode";
import { format, inferStyleTemplate } from "@sql-formatter/core";
import type { Dialect } from "@sql-formatter/core";
import { resolveTemplate } from "./resolveTemplate.js";
import { BUNDLED_TEMPLATES } from "./templates.js";

const DIALECTS: Dialect[] = ["generic", "postgres", "snowflake", "sqlite"];

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

  context.subscriptions.push(formattingProvider, inferCommand);
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
