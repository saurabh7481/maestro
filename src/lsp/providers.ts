import * as monaco from "monaco-editor/editor/editor.api";

type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
type MarkupContent = { kind: "plaintext" | "markdown"; value: string };

export interface LspRequestRouter {
  capability(model: monaco.editor.ITextModel, method: string): unknown;
  request<T>(
    model: monaco.editor.ITextModel,
    method: string,
    params: unknown,
    token: monaco.CancellationToken,
  ): Promise<T | null>;
  workspaceEdit(
    model: monaco.editor.ITextModel,
    edit: unknown,
  ): { edit?: monaco.languages.WorkspaceEdit; rejection?: string };
}

const LANGUAGES = ["typescript", "javascript", "rust", "python", "go"];

function lspPosition(position: monaco.Position): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function monacoRange(range: LspRange): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function textDocumentPosition(model: monaco.editor.ITextModel, position: monaco.Position) {
  return { textDocument: { uri: model.uri.toString() }, position: lspPosition(position) };
}

function markdown(value: unknown): monaco.IMarkdownString[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry): monaco.IMarkdownString[] => {
    if (typeof entry === "string") return [{ value: entry }];
    if (typeof entry === "object" && entry && "language" in entry && "value" in entry) {
      const code = entry as { language: string; value: string };
      return [{ value: `\`\`\`${code.language}\n${code.value}\n\`\`\`` }];
    }
    if (typeof entry === "object" && entry && "value" in entry) {
      const content = entry as MarkupContent;
      return [
        {
          value:
            content.kind === "plaintext"
              ? content.value.replace(/[\\`*_{}[\]()#+.!-]/g, "\\$&")
              : content.value,
        },
      ];
    }
    return [];
  });
}

type LspCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range?: LspRange; insert?: LspRange; newText: string };
  additionalTextEdits?: { range: LspRange; newText: string }[];
  commitCharacters?: string[];
  preselect?: boolean;
  tags?: number[];
};

type LspTextEdit = { range: LspRange; newText: string };

type LspCodeAction = {
  title: string;
  kind?: string;
  diagnostics?: unknown[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: unknown;
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: unknown;
};

export function completionItem(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  item: LspCompletionItem,
): monaco.languages.CompletionItem {
  const editRange = item.textEdit?.range ?? item.textEdit?.insert;
  const word = model.getWordUntilPosition(position);
  return {
    label: item.label,
    kind: Math.max(0, Math.min(24, (item.kind ?? 1) - 1)) as monaco.languages.CompletionItemKind,
    detail: item.detail,
    documentation: markdown(item.documentation)[0],
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    range: editRange
      ? monacoRange(editRange)
      : new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
    additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
      range: monacoRange(edit.range),
      text: edit.newText,
    })),
    commitCharacters: item.commitCharacters,
    preselect: item.preselect,
    tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
  };
}

type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
  originSelectionRange?: LspRange;
};

function locations(result: LspLocation | LspLocation[] | LspLocationLink[] | null) {
  if (!result) return [];
  return (Array.isArray(result) ? result : [result]).map((location) => {
    if ("targetUri" in location) {
      return {
        uri: monaco.Uri.parse(location.targetUri),
        range: monacoRange(location.targetRange),
        targetSelectionRange: monacoRange(location.targetSelectionRange),
        originSelectionRange: location.originSelectionRange
          ? monacoRange(location.originSelectionRange)
          : undefined,
      } satisfies monaco.languages.LocationLink;
    }
    return { uri: monaco.Uri.parse(location.uri), range: monacoRange(location.range) };
  });
}

function capabilityEnabled(
  router: LspRequestRouter,
  model: monaco.editor.ITextModel,
  method: string,
) {
  return !!router.capability(model, method);
}

export function registerLspProviders(router: LspRequestRouter): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = [];
  const completionRaw = new WeakMap<
    monaco.languages.CompletionItem,
    {
      model: monaco.editor.ITextModel;
      position: monaco.Position;
      raw: LspCompletionItem;
    }
  >();
  const codeActionRaw = new WeakMap<
    monaco.languages.CodeAction,
    {
      model: monaco.editor.ITextModel;
      raw: LspCodeAction;
    }
  >();
  for (const language of LANGUAGES) {
    disposables.push(
      monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position, token) => {
          if (!capabilityEnabled(router, model, "textDocument/hover")) return null;
          const result = await router.request<{ contents?: unknown; range?: LspRange }>(
            model,
            "textDocument/hover",
            textDocumentPosition(model, position),
            token,
          );
          if (!result) return null;
          return {
            contents: markdown(result.contents),
            range: result.range ? monacoRange(result.range) : undefined,
          };
        },
      }),
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", '"', "'", "/", "<", ":", "@", "#"],
        provideCompletionItems: async (model, position, context, token) => {
          const capability = router.capability(model, "textDocument/completion") as
            { triggerCharacters?: string[] } | undefined;
          if (!capability) return { suggestions: [] };
          if (
            context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter &&
            context.triggerCharacter &&
            !capability.triggerCharacters?.includes(context.triggerCharacter)
          ) {
            return { suggestions: [] };
          }
          const response = await router.request<
            LspCompletionItem[] | { items: LspCompletionItem[]; isIncomplete?: boolean }
          >(
            model,
            "textDocument/completion",
            {
              ...textDocumentPosition(model, position),
              context: {
                // Monaco's completion trigger enum is zero-based; LSP's is
                // one-based with the same order.
                triggerKind: context.triggerKind + 1,
                triggerCharacter: context.triggerCharacter,
              },
            },
            token,
          );
          const items = Array.isArray(response) ? response : (response?.items ?? []);
          const suggestions = items.map((item) => {
            const normalized = completionItem(model, position, item);
            completionRaw.set(normalized, { model, position, raw: item });
            return normalized;
          });
          return {
            suggestions,
            incomplete: !Array.isArray(response) && !!response?.isIncomplete,
          };
        },
        resolveCompletionItem: async (item, token) => {
          const stored = completionRaw.get(item);
          const capability = stored
            ? (router.capability(stored.model, "textDocument/completion") as {
                resolveProvider?: boolean;
              })
            : undefined;
          if (!stored || !capability?.resolveProvider) return item;
          const resolved = await router.request<LspCompletionItem>(
            stored.model,
            "completionItem/resolve",
            stored.raw,
            token,
          );
          if (!resolved) return item;
          const normalized = completionItem(stored.model, stored.position, resolved);
          completionRaw.set(normalized, { ...stored, raw: resolved });
          return normalized;
        },
      }),
      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ["(", ","],
        signatureHelpRetriggerCharacters: [","],
        provideSignatureHelp: async (model, position, token, context) => {
          const capability = router.capability(model, "textDocument/signatureHelp") as
            { triggerCharacters?: string[]; retriggerCharacters?: string[] } | undefined;
          if (!capability) return null;
          if (
            context.triggerKind === monaco.languages.SignatureHelpTriggerKind.TriggerCharacter &&
            context.triggerCharacter &&
            ![
              ...(capability.triggerCharacters ?? []),
              ...(capability.retriggerCharacters ?? []),
            ].includes(context.triggerCharacter)
          ) {
            return null;
          }
          const result = await router.request<{
            signatures: {
              label: string;
              documentation?: unknown;
              parameters?: { label: string | [number, number]; documentation?: unknown }[];
            }[];
            activeSignature?: number;
            activeParameter?: number;
          }>(
            model,
            "textDocument/signatureHelp",
            {
              ...textDocumentPosition(model, position),
              context: {
                triggerKind: context.triggerKind,
                triggerCharacter: context.triggerCharacter,
                isRetrigger: context.isRetrigger,
              },
            },
            token,
          );
          if (!result) return null;
          return {
            value: {
              signatures: result.signatures.map((signature) => ({
                label: signature.label,
                documentation: markdown(signature.documentation)[0],
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  label: parameter.label,
                  documentation: markdown(parameter.documentation)[0],
                })),
              })),
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
            },
            dispose() {},
          };
        },
      }),
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model, position, token) => {
          if (!capabilityEnabled(router, model, "textDocument/definition")) return null;
          const result = await router.request<LspLocation | LspLocation[] | LspLocationLink[]>(
            model,
            "textDocument/definition",
            textDocumentPosition(model, position),
            token,
          );
          return locations(result);
        },
      }),
      monaco.languages.registerReferenceProvider(language, {
        provideReferences: async (model, position, context, token) => {
          if (!capabilityEnabled(router, model, "textDocument/references")) return null;
          const result = await router.request<LspLocation[]>(
            model,
            "textDocument/references",
            {
              ...textDocumentPosition(model, position),
              context: { includeDeclaration: context.includeDeclaration },
            },
            token,
          );
          return locations(result) as monaco.languages.Location[];
        },
      }),
      monaco.languages.registerDocumentSymbolProvider(language, {
        provideDocumentSymbols: async (model, token) => {
          if (!capabilityEnabled(router, model, "textDocument/documentSymbol")) return [];
          const result = await router.request<unknown[]>(
            model,
            "textDocument/documentSymbol",
            { textDocument: { uri: model.uri.toString() } },
            token,
          );
          return documentSymbols(result ?? [], model.uri.toString());
        },
      }),
      monaco.languages.registerRenameProvider(language, {
        provideRenameEdits: async (model, position, newName, token) => {
          if (!capabilityEnabled(router, model, "textDocument/rename")) {
            return { edits: [], rejectReason: "The language server does not support rename." };
          }
          const result = await router.request<unknown>(
            model,
            "textDocument/rename",
            { ...textDocumentPosition(model, position), newName },
            token,
          );
          if (!result) return { edits: [], rejectReason: "No rename is available here." };
          const converted = router.workspaceEdit(model, result);
          return { edits: converted.edit?.edits ?? [], rejectReason: converted.rejection };
        },
        resolveRenameLocation: async (model, position, token) => {
          const capability = router.capability(model, "textDocument/rename") as
            { prepareProvider?: boolean } | boolean | undefined;
          if (!capability || typeof capability !== "object" || !capability.prepareProvider) {
            const word = model.getWordAtPosition(position);
            return word
              ? {
                  range: new monaco.Range(
                    position.lineNumber,
                    word.startColumn,
                    position.lineNumber,
                    word.endColumn,
                  ),
                  text: word.word,
                }
              : {
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column,
                  ),
                  text: "",
                };
          }
          const result = await router.request<LspRange | { range: LspRange; placeholder?: string }>(
            model,
            "textDocument/prepareRename",
            textDocumentPosition(model, position),
            token,
          );
          if (!result)
            return {
              range: new monaco.Range(1, 1, 1, 1),
              text: "",
              rejectReason: "This symbol cannot be renamed.",
            };
          const range = "range" in result ? result.range : result;
          return {
            range: monacoRange(range),
            text:
              "placeholder" in result && result.placeholder
                ? result.placeholder
                : model.getValueInRange(monacoRange(range)),
          };
        },
      }),
      monaco.languages.registerDocumentFormattingEditProvider(language, {
        displayName: "Language Server",
        provideDocumentFormattingEdits: async (model, options, token) => {
          if (!capabilityEnabled(router, model, "textDocument/formatting")) return [];
          const edits = await router.request<LspTextEdit[]>(
            model,
            "textDocument/formatting",
            {
              textDocument: { uri: model.uri.toString() },
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            },
            token,
          );
          return (edits ?? []).map((edit) => ({
            range: monacoRange(edit.range),
            text: edit.newText,
          }));
        },
      }),
      monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
        displayName: "Language Server",
        provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
          if (!capabilityEnabled(router, model, "textDocument/rangeFormatting")) return [];
          const edits = await router.request<LspTextEdit[]>(
            model,
            "textDocument/rangeFormatting",
            {
              textDocument: { uri: model.uri.toString() },
              range: {
                start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
              },
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            },
            token,
          );
          return (edits ?? []).map((edit) => ({
            range: monacoRange(edit.range),
            text: edit.newText,
          }));
        },
      }),
      monaco.languages.registerCodeActionProvider(
        language,
        {
          provideCodeActions: async (model, range, context, token) => {
            const capability = router.capability(model, "textDocument/codeAction");
            if (!capability) return { actions: [], dispose() {} };
            const actions = await router.request<
              (LspCodeAction | { title: string; command: string; arguments?: unknown[] })[]
            >(
              model,
              "textDocument/codeAction",
              {
                textDocument: { uri: model.uri.toString() },
                range: {
                  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
                },
                context: {
                  diagnostics: context.markers.map((marker) => ({
                    range: {
                      start: {
                        line: marker.startLineNumber - 1,
                        character: marker.startColumn - 1,
                      },
                      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
                    },
                    severity:
                      marker.severity === monaco.MarkerSeverity.Error
                        ? 1
                        : marker.severity === monaco.MarkerSeverity.Warning
                          ? 2
                          : marker.severity === monaco.MarkerSeverity.Info
                            ? 3
                            : 4,
                    message: marker.message,
                    source: marker.source,
                    code: marker.code,
                  })),
                  only: context.only,
                  triggerKind: context.trigger,
                },
              },
              token,
            );
            const normalized = (actions ?? []).map((raw): monaco.languages.CodeAction => {
              if ("command" in raw && typeof raw.command === "string") {
                return { title: raw.title, disabled: "Command-only actions are not enabled yet." };
              }
              const action = raw as LspCodeAction;
              const converted = action.edit ? router.workspaceEdit(model, action.edit) : {};
              const value: monaco.languages.CodeAction = {
                title: action.title,
                kind: action.kind,
                isPreferred: action.isPreferred,
                disabled: action.disabled?.reason ?? converted.rejection,
                edit: converted.edit,
              };
              if (action.command)
                value.disabled =
                  "This action also requires a server command, which Maestro does not execute yet.";
              codeActionRaw.set(value, { model, raw: action });
              return value;
            });
            return { actions: normalized, dispose() {} };
          },
          resolveCodeAction: async (action, token) => {
            const stored = codeActionRaw.get(action);
            const capability = stored
              ? (router.capability(stored.model, "textDocument/codeAction") as {
                  resolveProvider?: boolean;
                })
              : undefined;
            if (!stored || !capability?.resolveProvider) return action;
            const resolved = await router.request<LspCodeAction>(
              stored.model,
              "codeAction/resolve",
              stored.raw,
              token,
            );
            if (!resolved) return action;
            const converted = resolved.edit
              ? router.workspaceEdit(stored.model, resolved.edit)
              : {};
            return {
              ...action,
              edit: converted.edit,
              disabled:
                resolved.disabled?.reason ??
                converted.rejection ??
                (resolved.command
                  ? "This action also requires a server command, which Maestro does not execute yet."
                  : undefined),
            };
          },
        },
        { providedCodeActionKinds: ["quickfix", "refactor", "source"] },
      ),
    );
  }
  return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
}

type RawDocumentSymbol = {
  name: string;
  detail?: string;
  kind?: number;
  tags?: number[];
  range?: LspRange;
  selectionRange?: LspRange;
  children?: RawDocumentSymbol[];
  location?: LspLocation;
  containerName?: string;
};

export function documentSymbols(
  raw: unknown[],
  documentUri: string,
): monaco.languages.DocumentSymbol[] {
  return (raw as RawDocumentSymbol[]).flatMap((symbol) => {
    const location = symbol.location;
    if (location && location.uri !== documentUri) return [];
    const range = symbol.range ?? location?.range;
    if (!range) return [];
    return [
      {
        name: symbol.name,
        detail: symbol.detail ?? symbol.containerName ?? "",
        kind: Math.max(0, Math.min(25, (symbol.kind ?? 1) - 1)) as monaco.languages.SymbolKind,
        tags: symbol.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
        range: monacoRange(range),
        selectionRange: monacoRange(symbol.selectionRange ?? range),
        children: symbol.children ? documentSymbols(symbol.children, documentUri) : undefined,
      },
    ];
  });
}
