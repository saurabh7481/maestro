import type * as monacoNs from "monaco-editor/editor/editor.api";

/** Monaco's JSON support only ships bundled with the full `language/json`
 * service (worker-backed schema validation/completion, registered via
 * `monaco.contribution`) — unlike ini/yaml/etc. there's no standalone
 * Monarch tokenizer for it under `languages/definitions/*`
 * (`monacoModelRegistry.ts`'s other imports). Pulling in that whole
 * service would need a dedicated worker this app's
 * `MonacoEnvironment.getWorker()` doesn't provide (`monacoSetup.ts`), and
 * would register its own completion/hover providers that could shadow
 * `lsp/providers.ts`'s. This is a small, self-contained Monarch grammar
 * instead — syntax highlighting only, no worker, no providers, matching
 * how this app treats every other language: LSP for the smart stuff,
 * Monaco only for tokenizing. */
export function registerJsonLanguage(monaco: typeof monacoNs): void {
  monaco.languages.register({ id: "json", extensions: [".json", ".jsonc"], aliases: ["JSON"] });

  monaco.languages.setLanguageConfiguration("json", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider("json", {
    defaultToken: "invalid",
    tokenPostfix: ".json",
    tokenizer: {
      root: [
        // Object keys: a quoted string immediately followed by a colon.
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type.identifier"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
        [/true|false|null/, "keyword"],
        [/[{}]/, "delimiter.bracket"],
        [/[[\]]/, "delimiter.array"],
        [/[:,]/, "delimiter"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/[ \t\r\n]+/, "white"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
}
