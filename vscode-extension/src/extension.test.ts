import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal fake of the `vscode` module surface extension.ts touches. There's
// no real `vscode` package at runtime outside an actual extension host (only
// its types, via @types/vscode) — vitest's module mock stands in for it so
// activation/registration wiring can be exercised without launching VS Code
// itself (which would pop a visible window on the real desktop this ran on).
const {
  registerDocumentFormattingEditProvider,
  registerCommand,
  getConfiguration,
  getWorkspaceFolder,
  showErrorMessage,
  showWarningMessage,
  showInputBox,
  showQuickPick,
  openTextDocument,
  showTextDocument,
} = vi.hoisted(() => ({
  registerDocumentFormattingEditProvider: vi.fn((_selector: unknown, _provider: unknown) => ({ dispose: () => {} })),
  registerCommand: vi.fn((_id: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: () => {} })),
  getConfiguration: vi.fn(),
  getWorkspaceFolder: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
}));

vi.mock("vscode", () => ({
  languages: { registerDocumentFormattingEditProvider },
  commands: { registerCommand },
  workspace: { getConfiguration, getWorkspaceFolder, openTextDocument },
  window: {
    showErrorMessage,
    showWarningMessage,
    showInputBox,
    showQuickPick,
    showTextDocument,
    activeTextEditor: undefined as unknown,
  },
  Range: class Range {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
}));

import * as vscode from "vscode";
import { activate } from "./extension.js";

function fakeDocument(text: string) {
  return {
    uri: { fsPath: "/tmp/test.sql" },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfiguration.mockReturnValue({ get: () => "default" });
  getWorkspaceFolder.mockReturnValue(undefined);
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
});

describe("activate()", () => {
  it("registers a formatting provider for sql and the infer command", () => {
    const subscriptions: unknown[] = [];
    activate({ subscriptions } as never);

    expect(registerDocumentFormattingEditProvider).toHaveBeenCalledTimes(1);
    expect(registerDocumentFormattingEditProvider.mock.calls[0]![0]).toEqual({ language: "sql" });
    expect(registerCommand).toHaveBeenCalledWith("sqlFormatter.inferStyleFromSelection", expect.any(Function));
    expect(subscriptions).toHaveLength(2);
  });
});

describe("registered formatting provider", () => {
  it("formats a document using the resolved template", () => {
    activate({ subscriptions: [] } as never);
    const provider = registerDocumentFormattingEditProvider.mock.calls.at(-1)![1] as {
      provideDocumentFormattingEdits: (doc: ReturnType<typeof fakeDocument>) => { newText: string }[];
    };

    const edits = provider.provideDocumentFormattingEdits(fakeDocument("select a,b from users;"));

    expect(edits).toHaveLength(1);
    expect(edits[0]!.newText).toBe("SELECT\n  a,\n  b\nFROM users;\n");
  });

  it("uses the compact bundled template when configured", () => {
    getConfiguration.mockReturnValue({ get: () => "compact" });
    activate({ subscriptions: [] } as never);
    const provider = registerDocumentFormattingEditProvider.mock.calls.at(-1)![1] as {
      provideDocumentFormattingEdits: (doc: ReturnType<typeof fakeDocument>) => { newText: string }[];
    };

    const edits = provider.provideDocumentFormattingEdits(fakeDocument("select a, b from users;"));

    expect(edits[0]!.newText.toLowerCase()).toContain("select a, b");
  });

  it("shows an error and returns no edits when the configured template can't be resolved", () => {
    getConfiguration.mockReturnValue({ get: () => "/does/not/exist.json" });
    activate({ subscriptions: [] } as never);
    const provider = registerDocumentFormattingEditProvider.mock.calls.at(-1)![1] as {
      provideDocumentFormattingEdits: (doc: ReturnType<typeof fakeDocument>) => { newText: string }[];
    };

    const edits = provider.provideDocumentFormattingEdits(fakeDocument("select 1;"));

    expect(edits).toEqual([]);
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage.mock.calls[0]![0]).toMatch(/couldn't read template/);
  });
});

describe("sqlFormatter.inferStyleFromSelection command", () => {
  it("opens a JSON document with the inferred template when the user fills every prompt", async () => {
    activate({ subscriptions: [] } as never);
    const infer = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.inferStyleFromSelection")?.[1] as () => Promise<void>;

    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      selection: { isEmpty: true },
      document: { getText: () => "select a from users;" },
    };
    showInputBox.mockResolvedValueOnce("my-style").mockResolvedValueOnce("My Style");
    showQuickPick.mockResolvedValueOnce("postgres");
    openTextDocument.mockResolvedValue({ id: "fake-doc" });

    await infer();

    expect(openTextDocument).toHaveBeenCalledTimes(1);
    const content = openTextDocument.mock.calls[0]![0].content as string;
    const template = JSON.parse(content);
    expect(template.id).toBe("my-style");
    expect(template.dialect).toBe("postgres");
    expect(showTextDocument).toHaveBeenCalledWith({ id: "fake-doc" });
  });

  it("shows an error and does nothing when there's no active editor", async () => {
    activate({ subscriptions: [] } as never);
    const infer = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.inferStyleFromSelection")?.[1] as () => Promise<void>;

    await infer();

    expect(showErrorMessage).toHaveBeenCalledWith("SQL Formatter: open a SQL file first.");
    expect(openTextDocument).not.toHaveBeenCalled();
  });
});
