import * as monaco from "monaco-editor/editor/editor.api";
import {
  CancellationTokenSource,
  createMessageConnection,
  NullLogger,
  type MessageConnection,
} from "vscode-jsonrpc/browser";
import { lspApi } from "../api/lsp";
import type { LspServerKind, LspTransportEvent, RunningLspServer } from "../types/lsp";
import { useLspStore } from "../state/lspStore";
import { useProblemsStore } from "../state/problemsStore";
import type { Problem, ProblemRange, ProblemSeverity } from "../types/problem";
import { TauriMessageReader, TauriMessageWriter } from "./transport";
import { registerLspProviders, type LspRequestRouter } from "./providers";
import { registerMaestroEditorOpener } from "./editorOpener";
import { registerLspRuntimeControl } from "./runtimeBridge";

type DocumentModel = {
  model: monaco.editor.ITextModel;
  languageId: string;
  changeSubscription: monaco.IDisposable;
};

type Diagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
  tags?: number[];
  relatedInformation?: Array<{
    location: {
      uri: string;
      range: Diagnostic["range"];
    };
    message: string;
  }>;
};

type InitializeResult = {
  capabilities?: ServerCapabilities;
};

type ServerCapabilities = {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | object };
  hoverProvider?: boolean | object;
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  renameProvider?: boolean | { prepareProvider?: boolean };
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
};

const LANGUAGE_TO_SERVER: Record<string, LspServerKind | undefined> = {
  typescript: "typeScript",
  javascript: "typeScript",
  rust: "rustAnalyzer",
  python: "pyright",
  go: "gopls",
};

function problemSeverity(severity = 1): ProblemSeverity {
  return severity === 2 ? "warning" : severity === 3 ? "info" : severity === 4 ? "hint" : "error";
}

function problemRange(range: Diagnostic["range"]): ProblemRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function isPosition(value: unknown): value is { line: number; character: number } {
  const position = value as { line?: unknown; character?: unknown };
  return (
    Number.isInteger(position?.line) &&
    Number.isInteger(position?.character) &&
    Number(position.line) >= 0 &&
    Number(position.character) >= 0
  );
}

function isDiagnostic(value: unknown): value is Diagnostic {
  const diagnostic = value as Partial<Diagnostic>;
  return (
    typeof diagnostic?.message === "string" &&
    isPosition(diagnostic.range?.start) &&
    isPosition(diagnostic.range?.end)
  );
}

function normalizedFilePath(path: string) {
  const value = path.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[A-Z]:/.test(value) ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value;
}

function serverKey(worktreeId: string, kind: LspServerKind) {
  return `${worktreeId}:${kind}`;
}

type RawWorkspaceTextEdit = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
};

export function convertWorkspaceEdit(
  worktreeRoot: string,
  raw: unknown,
): { edit?: monaco.languages.WorkspaceEdit; rejection?: string } {
  type RawWorkspaceEdit = {
    changes?: Record<string, RawWorkspaceTextEdit[]>;
    documentChanges?: Array<
      | {
          textDocument: { uri: string; version?: number | null };
          edits: RawWorkspaceTextEdit[];
        }
      | { kind: string }
    >;
  };
  const edit = raw as RawWorkspaceEdit;
  const documents: Array<{
    uri: string;
    version?: number | null;
    edits: RawWorkspaceTextEdit[];
  }> = [];
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) documents.push({ uri, edits });
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (!("textDocument" in change)) {
        return { rejection: "File create, rename, and delete edits are not enabled yet." };
      }
      documents.push({
        uri: change.textDocument.uri,
        version: change.textDocument.version,
        edits: change.edits,
      });
    }
  }
  if (documents.length === 0) return { edit: { edits: [] } };

  const normalizePath = (path: string) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
    return /^[A-Z]:/.test(normalized)
      ? `${normalized[0]?.toLowerCase()}${normalized.slice(1)}`
      : normalized;
  };
  const root = normalizePath(worktreeRoot);
  const converted: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const document of documents) {
    const uri = monaco.Uri.parse(document.uri);
    if (uri.scheme !== "file")
      return { rejection: "The language server returned a non-file edit." };
    const path = normalizePath(uri.fsPath);
    if (path !== root && !path.startsWith(`${root}/`)) {
      return { rejection: "The language server tried to edit a file outside this worktree." };
    }
    const model = monaco.editor.getModel(uri);
    if (!model) {
      return {
        rejection:
          "This edit affects an unopened file. Open the affected files before applying it.",
      };
    }
    if (document.version != null && document.version !== model.getVersionId()) {
      return { rejection: "The affected file changed after this edit was calculated." };
    }
    const ranges: Array<{ start: number; end: number }> = [];
    for (const textEdit of document.edits) {
      const range = new monaco.Range(
        textEdit.range.start.line + 1,
        textEdit.range.start.character + 1,
        textEdit.range.end.line + 1,
        textEdit.range.end.character + 1,
      );
      const validated = model.validateRange(range);
      if (!validated.equalsRange(range)) {
        return { rejection: "The language server returned an invalid edit range." };
      }
      const start = model.getOffsetAt(validated.getStartPosition());
      const end = model.getOffsetAt(validated.getEndPosition());
      if (ranges.some((existing) => start < existing.end && end > existing.start)) {
        return { rejection: "The language server returned overlapping edits." };
      }
      ranges.push({ start, end });
      converted.push({
        resource: uri,
        versionId: model.getVersionId(),
        textEdit: { range: validated, text: textEdit.newText },
      });
    }
  }
  return { edit: { edits: converted } };
}

class LspClientSession {
  private readonly reader = new TauriMessageReader();
  private readonly connection: MessageConnection;
  private readonly running: Promise<RunningLspServer>;
  private readonly documents = new Map<string, DocumentModel>();
  private initialized = false;
  private disposed = false;
  private syncKind = 1;
  private supportsOpenClose = true;
  private supportsSave = false;
  private saveIncludesText = false;
  private capabilities: ServerCapabilities = {};

  constructor(
    private readonly worktreeId: string,
    private readonly worktreeRoot: string,
    private readonly kind: LspServerKind,
    private readonly onFailure: (detail: string) => void,
  ) {
    const key = serverKey(worktreeId, kind);
    // A newly-created server session is a new authority generation. Never
    // blend diagnostics retained from a crashed process with its replacement.
    useProblemsStore.getState().clearSource({ worktreeId, sourceKind: "lsp", sourceId: kind });
    useLspStore.getState().setRuntime(key, { status: "starting" });
    this.running = lspApi.startServer(worktreeId, worktreeRoot, kind, (event) =>
      this.handleTransportEvent(event),
    );
    const writer = new TauriMessageWriter(worktreeId, kind, this.running);
    this.connection = createMessageConnection(this.reader, writer, NullLogger);
    this.registerServerHandlers();
    this.connection.listen();
  }

  async start() {
    const rootUri = monaco.Uri.file(this.worktreeRoot).toString();
    try {
      const running = await this.running;
      const result = (await this.connection.sendRequest("initialize", {
        processId: null,
        clientInfo: { name: "Maestro", version: "0.1.0" },
        rootUri,
        workspaceFolders: [
          { uri: rootUri, name: this.worktreeRoot.split(/[\\/]/).pop() ?? "workspace" },
        ],
        ...(running.typeScriptSdk
          ? {
              initializationOptions: {
                // Keep project indexing isolated and bounded. The default
                // TypeScript server topology can launch a second syntax
                // process and consume several GB on large monorepos.
                disableAutomaticTypingAcquisition: true,
                maxTsServerMemory: 1024,
                tsserver: {
                  path: running.typeScriptSdk.path,
                  useSyntaxServer: "never",
                },
              },
            }
          : {}),
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
            applyEdit: false,
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                deprecatedSupport: true,
                tagSupport: { valueSet: [1] },
              },
              contextSupport: true,
            },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
              contextSupport: true,
            },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
              tagSupport: { valueSet: [1] },
            },
            rename: { prepareSupport: true },
            formatting: {},
            rangeFormatting: {},
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] },
              },
              resolveSupport: { properties: ["edit"] },
              dataSupport: true,
              isPreferredSupport: true,
              disabledSupport: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          window: { workDoneProgress: true },
        },
      })) as InitializeResult;
      this.capabilities = result.capabilities ?? {};
      const sync = result.capabilities?.textDocumentSync;
      this.syncKind = typeof sync === "number" ? sync : (sync?.change ?? 1);
      this.supportsOpenClose = typeof sync === "number" ? true : (sync?.openClose ?? false);
      this.supportsSave = typeof sync === "object" && !!sync.save;
      this.saveIncludesText =
        typeof sync === "object" && typeof sync.save === "object" && "includeText" in sync.save
          ? !!(sync.save as { includeText?: boolean }).includeText
          : false;
      this.connection.sendNotification("initialized", {});
      this.initialized = true;
      useLspStore.getState().setRuntime(serverKey(this.worktreeId, this.kind), { status: "ready" });
      for (const document of this.documents.values()) this.sendDidOpen(document);
    } catch (error) {
      useLspStore.getState().setRuntime(serverKey(this.worktreeId, this.kind), {
        status: "error",
        detail: String(error),
      });
      await this.stop(false);
      throw error;
    }
  }

  attach(model: monaco.editor.ITextModel, languageId: string) {
    const uri = model.uri.toString();
    if (this.documents.has(uri)) return;
    const document: DocumentModel = {
      model,
      languageId,
      changeSubscription: model.onDidChangeContent((event) => {
        if (!this.initialized || this.syncKind === 0) return;
        const contentChanges =
          this.syncKind === 2
            ? event.changes.map((change) => ({
                range: {
                  start: {
                    line: change.range.startLineNumber - 1,
                    character: change.range.startColumn - 1,
                  },
                  end: {
                    line: change.range.endLineNumber - 1,
                    character: change.range.endColumn - 1,
                  },
                },
                rangeLength: change.rangeLength,
                text: change.text,
              }))
            : [{ text: model.getValue() }];
        this.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri, version: model.getVersionId() },
          contentChanges,
        });
      }),
    };
    this.documents.set(uri, document);
    if (this.initialized) this.sendDidOpen(document);
  }

  didSave(model: monaco.editor.ITextModel) {
    if (!this.initialized || !this.supportsSave || !this.documents.has(model.uri.toString()))
      return;
    this.connection.sendNotification("textDocument/didSave", {
      textDocument: { uri: model.uri.toString() },
      ...(this.saveIncludesText ? { text: model.getValue() } : {}),
    });
  }

  capability(method: string): unknown {
    if (!this.initialized) return undefined;
    switch (method) {
      case "textDocument/hover":
        return this.capabilities.hoverProvider;
      case "textDocument/completion":
        return this.capabilities.completionProvider;
      case "textDocument/signatureHelp":
        return this.capabilities.signatureHelpProvider;
      case "textDocument/definition":
        return this.capabilities.definitionProvider;
      case "textDocument/references":
        return this.capabilities.referencesProvider;
      case "textDocument/documentSymbol":
        return this.capabilities.documentSymbolProvider;
      case "textDocument/rename":
        return this.capabilities.renameProvider;
      case "textDocument/formatting":
        return this.capabilities.documentFormattingProvider;
      case "textDocument/rangeFormatting":
        return this.capabilities.documentRangeFormattingProvider;
      case "textDocument/codeAction":
        return this.capabilities.codeActionProvider;
      default:
        return undefined;
    }
  }

  async request<T>(
    method: string,
    params: unknown,
    token: monaco.CancellationToken,
  ): Promise<T | null> {
    if (!this.initialized || token.isCancellationRequested) return null;
    const source = new CancellationTokenSource();
    const cancellation = token.onCancellationRequested(() => source.cancel());
    try {
      return (await this.connection.sendRequest(method, params, source.token)) as T;
    } catch (error) {
      if (token.isCancellationRequested) return null;
      throw error;
    } finally {
      cancellation.dispose();
      source.dispose();
    }
  }

  workspaceEdit(raw: unknown): { edit?: monaco.languages.WorkspaceEdit; rejection?: string } {
    return convertWorkspaceEdit(this.worktreeRoot, raw);
  }

  detach(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    const document = this.documents.get(uri);
    if (!document) return;
    document.changeSubscription.dispose();
    this.documents.delete(uri);
    if (this.initialized && this.supportsOpenClose) {
      this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
    monaco.editor.setModelMarkers(model, `maestro-lsp:${this.kind}`, []);
  }

  private sendDidOpen(document: DocumentModel) {
    if (!this.supportsOpenClose) return;
    this.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: document.model.uri.toString(),
        languageId: document.languageId,
        version: document.model.getVersionId(),
        text: document.model.getValue(),
      },
    });
  }

  private registerServerHandlers() {
    this.connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
      const payload = params as { uri?: string; version?: number; diagnostics?: Diagnostic[] };
      if (!payload.uri || !Array.isArray(payload.diagnostics)) return;
      let uri: monaco.Uri;
      try {
        uri = monaco.Uri.parse(payload.uri);
      } catch {
        return;
      }
      if (uri.scheme !== "file") return;
      const root = normalizedFilePath(this.worktreeRoot);
      const path = normalizedFilePath(uri.fsPath);
      if (path === root || !path.startsWith(`${root}/`)) return;
      const relativePath = path.slice(root.length + 1);
      const model = monaco.editor.getModel(uri);
      if (model && payload.version != null && payload.version < model.getVersionId()) return;
      const observedAt = Date.now();
      const problems: Problem[] = payload.diagnostics
        .filter(isDiagnostic)
        .map((diagnostic, index) => {
          const rawRange = problemRange(diagnostic.range);
          const range = model
            ? model.validateRange(
                new monaco.Range(
                  diagnostic.range.start.line + 1,
                  diagnostic.range.start.character + 1,
                  diagnostic.range.end.line + 1,
                  diagnostic.range.end.character + 1,
                ),
              )
            : rawRange;
          const normalizedRange: ProblemRange = {
            startLineNumber: Math.max(1, range.startLineNumber),
            startColumn: Math.max(1, range.startColumn),
            endLineNumber: Math.max(1, range.endLineNumber),
            endColumn: Math.max(1, range.endColumn),
          };
          const code = diagnostic.code == null ? undefined : String(diagnostic.code);
          return {
            id: [
              this.worktreeId,
              this.kind,
              payload.uri,
              normalizedRange.startLineNumber,
              normalizedRange.startColumn,
              code ?? "",
              diagnostic.message,
              index,
            ].join("\u0000"),
            worktreeId: this.worktreeId,
            sourceKind: "lsp",
            sourceId: this.kind,
            uri: payload.uri!,
            relativePath,
            range: normalizedRange,
            severity: problemSeverity(diagnostic.severity),
            message: diagnostic.message,
            code,
            relatedInformation: diagnostic.relatedInformation
              ?.filter(
                (related) =>
                  typeof related?.message === "string" &&
                  typeof related?.location?.uri === "string" &&
                  isPosition(related.location.range?.start) &&
                  isPosition(related.location.range?.end),
              )
              .map((related) => ({
                message: related.message,
                uri: related.location.uri,
                range: problemRange(related.location.range),
              })),
            tags: diagnostic.tags?.flatMap((tag) =>
              tag === 1 ? (["unnecessary"] as const) : tag === 2 ? (["deprecated"] as const) : [],
            ),
            observedDocumentVersion: payload.version,
            observedAt,
            stale: false,
          };
        });
      useProblemsStore.getState().replaceDocumentProblems({
        worktreeId: this.worktreeId,
        sourceKind: "lsp",
        sourceId: this.kind,
        uri: payload.uri,
        problems,
      });
      if (!model) return;
      const markers = problems.map((problem) => {
        return {
          ...problem.range,
          severity:
            problem.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : problem.severity === "info"
                ? monaco.MarkerSeverity.Info
                : problem.severity === "hint"
                  ? monaco.MarkerSeverity.Hint
                  : monaco.MarkerSeverity.Error,
          message: problem.message,
          source: problem.sourceId,
          code: problem.code,
          tags: problem.tags?.flatMap((tag) =>
            tag === "unnecessary"
              ? [monaco.MarkerTag.Unnecessary]
              : tag === "deprecated"
                ? [monaco.MarkerTag.Deprecated]
                : [],
          ),
        };
      });
      monaco.editor.setModelMarkers(model, `maestro-lsp:${this.kind}`, markers);
    });
    this.connection.onNotification("$/typescriptVersion", (params: unknown) => {
      const payload = params as { version?: unknown; source?: unknown };
      if (typeof payload.version !== "string") return;
      const source = typeof payload.source === "string" ? ` (${payload.source})` : "";
      useLspStore.getState().setRuntime(serverKey(this.worktreeId, this.kind), {
        status: "ready",
        detail: `TypeScript ${payload.version}${source}`,
      });
    });
    this.connection.onNotification("window/logMessage", (params: unknown) => {
      const message = (params as { message?: unknown })?.message;
      if (typeof message !== "string") return;
      const normalized = message.toLowerCase();
      if (
        normalized.includes("heap out of memory") ||
        normalized.includes("tsserver process has exited") ||
        normalized.includes("tsserver process has failed to start")
      ) {
        this.failInternal(message);
      }
    });
    this.connection.onRequest("workspace/configuration", (params: unknown) => {
      const items = (params as { items?: { section?: string }[] })?.items;
      return Array.isArray(items)
        ? items.map((item) =>
            item.section === "formattingOptions" ? { tabSize: 2, insertSpaces: true } : null,
          )
        : [];
    });
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("client/unregisterCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "Workspace edits are not enabled in this Maestro milestone.",
    }));
  }

  private handleTransportEvent(event: LspTransportEvent) {
    this.reader.accept(event);
    if (event.type === "stderr") {
      const normalized = event.line.toLowerCase();
      const internalServerFailed =
        normalized.includes("heap out of memory") ||
        normalized.includes("tsserver process has exited") ||
        normalized.includes("tsserver process has failed to start");
      if (internalServerFailed) {
        this.failInternal(event.line);
        return;
      }
      useLspStore.getState().setRuntime(serverKey(this.worktreeId, this.kind), {
        status: this.initialized ? "ready" : "starting",
        detail: event.line,
      });
    } else if (event.type === "exited" && !this.disposed) {
      useProblemsStore.getState().markSourceStale({
        worktreeId: this.worktreeId,
        sourceKind: "lsp",
        sourceId: this.kind,
      });
      useLspStore.getState().setRuntime(serverKey(this.worktreeId, this.kind), {
        status: "error",
        detail:
          event.detail ?? `Language server exited${event.code == null ? "" : ` (${event.code})`}.`,
      });
      this.onFailure(
        event.detail ?? `Language server exited${event.code == null ? "" : ` (${event.code})`}.`,
      );
    }
  }

  private failInternal(rawDetail: string) {
    if (this.disposed) return;
    const detail = rawDetail.toLowerCase().includes("heap out of memory")
      ? "TypeScript exceeded Maestro's 1 GB language-server memory budget. Narrow the project's tsconfig includes/types before retrying."
      : rawDetail;
    useProblemsStore.getState().markSourceStale({
      worktreeId: this.worktreeId,
      sourceKind: "lsp",
      sourceId: this.kind,
    });
    useLspStore.getState().setRuntime(serverKey(this.worktreeId, this.kind), {
      status: "error",
      detail,
    });
    this.onFailure(detail);
    void this.stop(false);
  }

  async stop(graceful = true) {
    if (this.disposed) return;
    this.disposed = true;
    if (graceful) {
      useProblemsStore.getState().clearSource({
        worktreeId: this.worktreeId,
        sourceKind: "lsp",
        sourceId: this.kind,
      });
    }
    for (const document of this.documents.values()) document.changeSubscription.dispose();
    if (graceful && this.initialized) {
      try {
        await this.connection.sendRequest("shutdown");
        this.connection.sendNotification("exit");
      } catch {
        // Native stop below remains the cleanup authority.
      }
    }
    this.connection.dispose();
    try {
      const running = await this.running;
      await lspApi.stopServer(this.worktreeId, this.kind, running.generation);
    } catch {
      // A process that failed during startup may already be gone.
    }
  }
}

class LspClientManager implements LspRequestRouter {
  private readonly sessions = new Map<string, LspClientSession>();
  private readonly modelSessionKeys = new Map<string, string>();
  private readonly modelContexts = new Map<
    string,
    {
      model: monaco.editor.ITextModel;
      worktreeId: string;
      worktreeRoot: string;
    }
  >();
  private readonly failedUntil = new Map<string, number>();
  private readonly enablementByWorktree = new Map<string, Promise<boolean>>();

  constructor() {
    registerLspProviders(this);
    registerMaestroEditorOpener();
    registerLspRuntimeControl({
      retry: (kind) => this.retry(kind),
      refresh: () => this.refresh(),
    });
  }

  attachModel(model: monaco.editor.ITextModel, worktreeId: string, worktreeRoot: string) {
    const kind = LANGUAGE_TO_SERVER[model.getLanguageId()];
    if (!kind) return;
    this.modelContexts.set(model.uri.toString(), { model, worktreeId, worktreeRoot });
    void this.attachModelIfEnabled(model, worktreeId, worktreeRoot, kind);
  }

  private async attachModelIfEnabled(
    model: monaco.editor.ITextModel,
    worktreeId: string,
    worktreeRoot: string,
    kind: LspServerKind,
  ) {
    const key = serverKey(worktreeId, kind);
    if ((this.failedUntil.get(key) ?? 0) > Date.now()) return;
    let enablement = this.enablementByWorktree.get(worktreeId);
    if (!enablement) {
      enablement = lspApi.isEnabledForWorktree(worktreeId);
      this.enablementByWorktree.set(worktreeId, enablement);
    }
    let enabled: boolean;
    try {
      enabled = await enablement;
    } catch (error) {
      this.enablementByWorktree.delete(worktreeId);
      useLspStore.getState().setRuntime(key, { status: "error", detail: String(error) });
      return;
    }
    // The model may have been evicted/closed while the native preflight was
    // in flight. Never create a session for stale editor state.
    if (!this.modelContexts.has(model.uri.toString())) return;
    if (!enabled) {
      useLspStore.getState().setRuntime(key, {
        status: "disabled",
        detail: "Language intelligence is disabled for this project.",
      });
      return;
    }
    let session = this.sessions.get(key);
    if (!session) {
      const created = new LspClientSession(worktreeId, worktreeRoot, kind, () => {
        if (this.sessions.get(key) !== created) return;
        this.sessions.delete(key);
        this.failedUntil.set(key, Date.now() + 30_000);
      });
      session = created;
      this.sessions.set(key, session);
      void session.start().catch(() => {
        this.sessions.delete(key);
        // Opening several files after a missing/incompatible server failure
        // must not spawn and crash a fresh process for every tab.
        this.failedUntil.set(key, Date.now() + 30_000);
      });
    }
    session.attach(model, model.getLanguageId());
    this.modelSessionKeys.set(model.uri.toString(), key);
  }

  didSave(model: monaco.editor.ITextModel) {
    const key = this.modelSessionKeys.get(model.uri.toString());
    if (key) this.sessions.get(key)?.didSave(model);
  }

  capability(model: monaco.editor.ITextModel, method: string): unknown {
    const key = this.modelSessionKeys.get(model.uri.toString());
    return key ? this.sessions.get(key)?.capability(method) : undefined;
  }

  request<T>(
    model: monaco.editor.ITextModel,
    method: string,
    params: unknown,
    token: monaco.CancellationToken,
  ): Promise<T | null> {
    const key = this.modelSessionKeys.get(model.uri.toString());
    const session = key ? this.sessions.get(key) : undefined;
    return session ? session.request<T>(method, params, token) : Promise.resolve(null);
  }

  workspaceEdit(
    model: monaco.editor.ITextModel,
    edit: unknown,
  ): { edit?: monaco.languages.WorkspaceEdit; rejection?: string } {
    const key = this.modelSessionKeys.get(model.uri.toString());
    const session = key ? this.sessions.get(key) : undefined;
    return session
      ? session.workspaceEdit(edit)
      : { rejection: "The language server session is not available." };
  }

  detachModel(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    this.modelContexts.delete(uri);
    const key = this.modelSessionKeys.get(uri);
    if (!key) return;
    this.sessions.get(key)?.detach(model);
    this.modelSessionKeys.delete(uri);
  }

  private async retry(kind: LspServerKind) {
    const suffix = `:${kind}`;
    for (const key of [...this.failedUntil.keys()]) {
      if (key.endsWith(suffix)) this.failedUntil.delete(key);
    }
    const sessions = [...this.sessions.entries()].filter(([key]) => key.endsWith(suffix));
    for (const [key, session] of sessions) {
      this.sessions.delete(key);
      await session.stop();
    }
    for (const context of this.modelContexts.values()) {
      if (LANGUAGE_TO_SERVER[context.model.getLanguageId()] === kind) {
        this.attachModel(context.model, context.worktreeId, context.worktreeRoot);
      }
    }
  }

  private async refresh() {
    this.enablementByWorktree.clear();
    const kinds = new Set<LspServerKind>();
    for (const context of this.modelContexts.values()) {
      const kind = LANGUAGE_TO_SERVER[context.model.getLanguageId()];
      if (kind) kinds.add(kind);
    }
    for (const kind of kinds) await this.retry(kind);
  }
}

export const lspClientManager = new LspClientManager();
