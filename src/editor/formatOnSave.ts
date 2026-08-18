import * as monaco from "monaco-editor/editor/editor.api";
import type { Plugin } from "prettier";
import { lspClientManager } from "../lsp/clientManager";
import { monacoRange, type LspRange } from "../lsp/providers";

type LspTextEdit = { range: LspRange; newText: string };

interface PrettierLanguageConfig {
  parser: string;
  loadPlugins: () => Promise<Plugin[]>;
}

// Prettier's v3 plugin split needs the parser plugin (`babel`/
// `typescript`) *and* the `estree` printer alongside it for JS/TS/JSON —
// the parser alone only produces an AST, `estree` is what turns it back
// into formatted text. CSS/HTML/Markdown/YAML are self-contained.
const PRETTIER_LANGUAGES: Record<string, PrettierLanguageConfig> = {
  typescript: {
    parser: "typescript",
    loadPlugins: async () => {
      const [ts, estree] = await Promise.all([
        import("prettier/plugins/typescript"),
        import("prettier/plugins/estree"),
      ]);
      return [ts.default, estree.default];
    },
  },
  javascript: {
    parser: "babel",
    loadPlugins: async () => {
      const [babel, estree] = await Promise.all([
        import("prettier/plugins/babel"),
        import("prettier/plugins/estree"),
      ]);
      return [babel.default, estree.default];
    },
  },
  json: {
    // The `json`/`json5`/`jsonc` parsers live in the `babel` plugin, not
    // a dedicated one.
    parser: "json",
    loadPlugins: async () => {
      const [babel, estree] = await Promise.all([
        import("prettier/plugins/babel"),
        import("prettier/plugins/estree"),
      ]);
      return [babel.default, estree.default];
    },
  },
  css: {
    parser: "css",
    loadPlugins: async () => [(await import("prettier/plugins/postcss")).default],
  },
  scss: {
    parser: "scss",
    loadPlugins: async () => [(await import("prettier/plugins/postcss")).default],
  },
  less: {
    parser: "less",
    loadPlugins: async () => [(await import("prettier/plugins/postcss")).default],
  },
  html: {
    parser: "html",
    loadPlugins: async () => [(await import("prettier/plugins/html")).default],
  },
  markdown: {
    parser: "markdown",
    loadPlugins: async () => [(await import("prettier/plugins/markdown")).default],
  },
  yaml: {
    parser: "yaml",
    loadPlugins: async () => [(await import("prettier/plugins/yaml")).default],
  },
};

/** Tries the active LSP session's formatter. Returns `true` whenever the
 * capability exists — including when it ran but produced zero edits
 * (already formatted) — since that means formatting was *handled*, and
 * `formatModelBeforeSave` shouldn't then also run Prettier over the same
 * model with a second, potentially different opinion. Only `false` (no
 * `textDocument/formatting` capability at all) falls through to it. */
async function formatWithLsp(model: monaco.editor.ITextModel): Promise<boolean> {
  if (!lspClientManager.capability(model, "textDocument/formatting")) return false;

  try {
    const cts = new monaco.CancellationTokenSource();
    const options = model.getOptions();
    const edits = await lspClientManager.request<LspTextEdit[]>(
      model,
      "textDocument/formatting",
      {
        textDocument: { uri: model.uri.toString() },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      },
      cts.token,
    );
    if (edits && edits.length > 0) {
      model.pushEditOperations(
        [],
        edits.map((edit) => ({ range: monacoRange(edit.range), text: edit.newText })),
        () => null,
      );
    }
  } catch {
    // A formatting request failing (server hiccup, file mid-edit and
    // momentarily unparsable, ...) isn't a reason to block the save.
  }
  return true;
}

async function formatWithPrettier(model: monaco.editor.ITextModel): Promise<void> {
  const config = PRETTIER_LANGUAGES[model.getLanguageId()];
  if (!config) return;

  const current = model.getValue();
  let formatted: string;
  try {
    const [{ format }, plugins] = await Promise.all([
      import("prettier/standalone"),
      config.loadPlugins(),
    ]);
    formatted = await format(current, { parser: config.parser, plugins });
  } catch {
    // A file mid-edit is frequently not syntactically valid — skip
    // reformatting this once rather than blocking the save over it.
    return;
  }
  if (formatted === current) return;
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: formatted }],
    () => null,
  );
}

/** Reformats `model` in place before a save: the active LSP's formatter
 * if `textDocument/formatting` is available, otherwise the bundled
 * Prettier fallback for the languages it supports (JS/TS, JSON,
 * CSS/SCSS/LESS, HTML, Markdown, YAML) — Prettier runs entirely
 * client-side (`prettier/standalone`), no language server needed. A
 * no-op for everything else (Rust, Python, Go, ...): no Prettier plugin
 * exists for them, and shelling out to their own formatters
 * (rustfmt/black/gofmt) isn't wired up.
 *
 * Takes a model rather than an editor instance deliberately — models are
 * shared app-wide (`monacoModelRegistry`) independent of which pane, if
 * any, currently has one open, so this works equally from `saveFileTab`
 * whether the save was triggered by `MonacoHost`'s autosave debounce or
 * `AppShell`'s Cmd/Ctrl+S handler, neither of which otherwise has a
 * reason to reach for the live editor widget. Uses `pushEditOperations`
 * rather than `model.setValue()` so undo history survives a reformat
 * instead of the whole buffer being replaced. */
export async function formatModelBeforeSave(model: monaco.editor.ITextModel): Promise<void> {
  if (await formatWithLsp(model)) return;
  await formatWithPrettier(model);
}
