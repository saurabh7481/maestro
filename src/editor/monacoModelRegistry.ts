import * as monaco from "monaco-editor";
import { ensureMonacoEnvironment } from "./monacoSetup";

ensureMonacoEnvironment();

const MAX_MODELS = 10;

/** Insertion order doubles as LRU order — accessing a model deletes and
 * re-inserts it so the least-recently-used entry always sits first. */
const models = new Map<string, monaco.editor.ITextModel>();

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  rs: "rust",
  py: "python",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  rb: "ruby",
  go: "go",
  toml: "ini",
  vue: "html",
};

export function languageForPath(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  const ext = relPath.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? "plaintext";
}

function evictLeastRecentlyUsed() {
  while (models.size > MAX_MODELS) {
    const oldestKey = models.keys().next().value;
    if (oldestKey === undefined) break;
    models.get(oldestKey)?.dispose();
    models.delete(oldestKey);
  }
}

/** `tabId` is already unique per (worktree, file) — see `fileTabId()` in
 * `tabsStore.ts` — so it doubles as the model's URI path. */
export function getOrCreateModel(
  tabId: string,
  relPath: string,
  content: string,
  plaintextOverride = false,
): monaco.editor.ITextModel {
  const existing = models.get(tabId);
  if (existing) {
    models.delete(tabId);
    models.set(tabId, existing);
    return existing;
  }

  const uri = monaco.Uri.from({ scheme: "maestro-file", path: `/${tabId}` });
  const language = plaintextOverride ? "plaintext" : languageForPath(relPath);
  const model = monaco.editor.createModel(content, language, uri);
  models.set(tabId, model);
  evictLeastRecentlyUsed();
  return model;
}

export function getModel(tabId: string): monaco.editor.ITextModel | undefined {
  return models.get(tabId);
}

export function disposeModel(tabId: string) {
  const model = models.get(tabId);
  if (model) {
    model.dispose();
    models.delete(tabId);
  }
}
