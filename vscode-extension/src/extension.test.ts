import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal fake of the `vscode` module surface extension.ts touches. There's
// no real `vscode` package at runtime outside an actual extension host (only
// its types, via @types/vscode) — vitest's module mock stands in for it so
// activation/registration wiring can be exercised without launching VS Code
// itself (which would pop a visible window on the real desktop this ran on).
const {
  registerDocumentFormattingEditProvider,
  registerCommand,
  createDiagnosticCollection,
  getConfiguration,
  getWorkspaceFolder,
  showErrorMessage,
  showWarningMessage,
  showInformationMessage,
  showInputBox,
  showQuickPick,
  openTextDocument,
  showTextDocument,
  withProgress,
  diagnosticsSet,
  diagnosticsGet,
  messagesCreate,
} = vi.hoisted(() => ({
  registerDocumentFormattingEditProvider: vi.fn((_selector: unknown, _provider: unknown) => ({ dispose: () => {} })),
  registerCommand: vi.fn((_id: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: () => {} })),
  createDiagnosticCollection: vi.fn((_name: string) => ({ set: diagnosticsSet, get: diagnosticsGet, dispose: () => {} })),
  getConfiguration: vi.fn(),
  getWorkspaceFolder: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  withProgress: vi.fn((_opts: unknown, task: () => unknown) => task()),
  diagnosticsSet: vi.fn(),
  diagnosticsGet: vi.fn(() => []),
  messagesCreate: vi.fn(),
}));

vi.mock("vscode", () => ({
  languages: { registerDocumentFormattingEditProvider, createDiagnosticCollection },
  commands: { registerCommand },
  workspace: { getConfiguration, getWorkspaceFolder, openTextDocument },
  window: {
    showErrorMessage,
    showWarningMessage,
    showInformationMessage,
    showInputBox,
    showQuickPick,
    showTextDocument,
    withProgress,
    activeTextEditor: undefined as unknown,
  },
  Range: class Range {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  Position: class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Diagnostic: class Diagnostic {
    source?: string;
    code?: string;
    constructor(
      public range: unknown,
      public message: string,
      public severity: unknown,
    ) {}
  },
  DiagnosticSeverity: { Warning: 1, Information: 2 },
  ProgressLocation: { Notification: 1 },
  TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: messagesCreate };
    constructor(public opts: { apiKey: string }) {}
  },
}));

import * as vscode from "vscode";
import { activate } from "./extension.js";

function fakeContext(secrets?: Partial<{ get: () => Promise<string | undefined>; store: () => Promise<void> }>) {
  return {
    subscriptions: [],
    secrets: {
      get: vi.fn(secrets?.get ?? (() => Promise.resolve(undefined))),
      store: vi.fn(secrets?.store ?? (() => Promise.resolve())),
    },
  };
}

function fakeDocument(text: string) {
  const lines = text.split("\n");
  return {
    uri: { fsPath: "/tmp/test.sql" },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfiguration.mockReturnValue({ get: () => "default" });
  getWorkspaceFolder.mockReturnValue(undefined);
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
});

describe("activate()", () => {
  it("registers a formatting provider, the infer command, and the portability command", () => {
    const subscriptions: unknown[] = [];
    activate({ subscriptions } as never);

    expect(registerDocumentFormattingEditProvider).toHaveBeenCalledTimes(1);
    expect(registerDocumentFormattingEditProvider.mock.calls[0]![0]).toEqual({ language: "sql" });
    expect(registerCommand).toHaveBeenCalledWith("sqlFormatter.inferStyleFromSelection", expect.any(Function));
    expect(registerCommand).toHaveBeenCalledWith("sqlFormatter.checkPortability", expect.any(Function));
    expect(registerCommand).toHaveBeenCalledWith("sqlFormatter.deepCheckPortability", expect.any(Function));
    expect(registerCommand).toHaveBeenCalledWith("sqlFormatter.setAnthropicApiKey", expect.any(Function));
    expect(createDiagnosticCollection).toHaveBeenCalledWith("sqlFormatterPortability");
    expect(subscriptions).toHaveLength(6);
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

describe("sqlFormatter.checkPortability command", () => {
  it("sets diagnostics and warns when findings are present", async () => {
    activate({ subscriptions: [] } as never);
    const check = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.checkPortability")?.[1] as () => Promise<void>;

    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: fakeDocument("select id from t qualify row_number() over (order by id) = 1;"),
    };
    showQuickPick.mockResolvedValueOnce("snowflake").mockResolvedValueOnce("redshift");

    await check();

    expect(diagnosticsSet).toHaveBeenCalledTimes(1);
    const diags = diagnosticsSet.mock.calls[0]![1] as { message: string; code: string }[];
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("snowflake-qualify");
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("1 portability finding"));
  });

  it("clears diagnostics and informs when there are no findings", async () => {
    activate({ subscriptions: [] } as never);
    const check = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.checkPortability")?.[1] as () => Promise<void>;

    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: fakeDocument("select id from t;"),
    };
    showQuickPick.mockResolvedValueOnce("snowflake").mockResolvedValueOnce("redshift");

    await check();

    expect(diagnosticsSet).toHaveBeenCalledWith(expect.anything(), []);
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no portability findings"));
  });

  it("does nothing when the source dialect prompt is cancelled", async () => {
    activate({ subscriptions: [] } as never);
    const check = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.checkPortability")?.[1] as () => Promise<void>;

    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: fakeDocument("select 1;"),
    };
    showQuickPick.mockResolvedValueOnce(undefined);

    await check();

    expect(diagnosticsSet).not.toHaveBeenCalled();
  });

  it("shows an error and does nothing when there's no active editor", async () => {
    activate({ subscriptions: [] } as never);
    const check = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.checkPortability")?.[1] as () => Promise<void>;

    await check();

    expect(showErrorMessage).toHaveBeenCalledWith("SQL Formatter: open a SQL file first.");
    expect(diagnosticsSet).not.toHaveBeenCalled();
  });
});

describe("sqlFormatter.setAnthropicApiKey command", () => {
  it("stores the entered key via SecretStorage", async () => {
    const context = fakeContext();
    activate(context as never);
    const setKey = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.setAnthropicApiKey")?.[1] as () => Promise<void>;

    showInputBox.mockResolvedValueOnce("sk-ant-test-key");

    await setKey();

    expect(context.secrets.store).toHaveBeenCalledWith("sqlFormatter.anthropicApiKey", "sk-ant-test-key");
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("saved"));
  });

  it("does nothing when the input box is cancelled", async () => {
    const context = fakeContext();
    activate(context as never);
    const setKey = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.setAnthropicApiKey")?.[1] as () => Promise<void>;

    showInputBox.mockResolvedValueOnce(undefined);

    await setKey();

    expect(context.secrets.store).not.toHaveBeenCalled();
  });
});

describe("sqlFormatter.deepCheckPortability command", () => {
  it("shows an error and does nothing when there's no active editor", async () => {
    const context = fakeContext({ get: () => Promise.resolve("sk-ant-test-key") });
    activate(context as never);
    const deepCheck = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.deepCheckPortability")?.[1] as () => Promise<void>;

    await deepCheck();

    expect(showErrorMessage).toHaveBeenCalledWith("SQL Formatter: open a SQL file first.");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("prompts to set an API key when none is saved, and bails if declined", async () => {
    const context = fakeContext({ get: () => Promise.resolve(undefined) });
    activate(context as never);
    const deepCheck = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.deepCheckPortability")?.[1] as () => Promise<void>;

    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: fakeDocument("select 1;"),
    };
    showInformationMessage.mockResolvedValueOnce("Cancel");

    await deepCheck();

    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Deep Check sends this file's SQL"), "Set API Key", "Cancel");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("calls the Claude API and adds Information-severity diagnostics for findings", async () => {
    const context = fakeContext({ get: () => Promise.resolve("sk-ant-test-key") });
    activate(context as never);
    const deepCheck = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.deepCheckPortability")?.[1] as () => Promise<void>;

    const sql = "select to_date(created_at) from t;";
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: fakeDocument(sql),
    };
    showQuickPick.mockResolvedValueOnce("snowflake").mockResolvedValueOnce("redshift");
    messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            findings: [{ snippet: "to_date(created_at)", message: "single-arg TO_DATE differs", confidence: "medium" }],
          }),
        },
      ],
    });

    await deepCheck();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(diagnosticsSet).toHaveBeenCalledTimes(1);
    const diags = diagnosticsSet.mock.calls[0]![1] as { message: string; severity: unknown }[];
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("unverified");
    expect(diags[0]!.severity).toBe(2);
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("1 additional finding"));
  });

  it("shows an error when the API call fails", async () => {
    const context = fakeContext({ get: () => Promise.resolve("sk-ant-test-key") });
    activate(context as never);
    const deepCheck = registerCommand.mock.calls.find((c) => c[0] === "sqlFormatter.deepCheckPortability")?.[1] as () => Promise<void>;

    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: fakeDocument("select 1;"),
    };
    showQuickPick.mockResolvedValueOnce("snowflake").mockResolvedValueOnce("redshift");
    messagesCreate.mockRejectedValueOnce(new Error("network error"));

    await deepCheck();

    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("deep check failed"));
  });
});
