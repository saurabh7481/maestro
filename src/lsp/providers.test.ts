import { afterEach, describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { completionItem, documentSymbols, monacoRange } from "./providers";

afterEach(() => {
  for (const model of monaco.editor.getModels()) model.dispose();
});

describe("LSP provider normalization", () => {
  it("converts zero-based LSP ranges to one-based Monaco ranges", () => {
    const range = monacoRange({
      start: { line: 2, character: 4 },
      end: { line: 3, character: 1 },
    });
    expect(range.startLineNumber).toBe(3);
    expect(range.startColumn).toBe(5);
    expect(range.endLineNumber).toBe(4);
    expect(range.endColumn).toBe(2);
  });

  it("preserves completion text edits and snippet semantics", () => {
    const model = monaco.editor.createModel("con", "plaintext", monaco.Uri.file("/tmp/a.ts"));
    const item = completionItem(model, new monaco.Position(1, 4), {
      label: "console",
      kind: 6,
      insertTextFormat: 2,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
        newText: "console.${1:log}($0)",
      },
    });
    expect(item.insertText).toBe("console.${1:log}($0)");
    expect(item.insertTextRules).toBe(
      monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    );
    expect((item.range as monaco.Range).endColumn).toBe(4);
  });

  it("retains nested document symbols and excludes another document", () => {
    const symbols = documentSymbols(
      [
        {
          name: "outer",
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 14 },
          },
          children: [
            {
              name: "inner",
              kind: 6,
              range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
            },
          ],
        },
        {
          name: "foreign",
          location: {
            uri: "file:///tmp/b.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        },
      ],
      "file:///tmp/a.ts",
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.children?.[0]?.name).toBe("inner");
  });
});
