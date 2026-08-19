import * as monaco from "monaco-editor/editor/editor.api";
// Register only the grammars Maestro can assign. Monaco's aggregate
// contribution eagerly registers 80+ languages and adds several megabytes to
// the first editor load in large projects.
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/less/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/ruby/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/yaml/register";
import { ensureMonacoEnvironment } from "./monacoSetup";
import { registerJsonLanguage } from "./jsonLanguage";
import { lspClientManager } from "../lsp/clientManager";
import { languageForPath } from "./languages";
import { registerEditorModelApi } from "./modelBridge";

ensureMonacoEnvironment();
registerJsonLanguage(monaco);

const MAX_MODELS = 10;

/** Insertion order doubles as LRU order — accessing a model deletes and
 * re-inserts it so the least-recently-used entry always sits first. */
const models = new Map<string, monaco.editor.ITextModel>();

export { languageForPath } from "./languages";

function evictLeastRecentlyUsed() {
  while (models.size > MAX_MODELS) {
    const oldestKey = models.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = models.get(oldestKey);
    if (oldest) {
      lspClientManager.detachModel(oldest);
      oldest.dispose();
    }
    models.delete(oldestKey);
  }
}

/** `tabId` is already unique per (worktree, file) — see `fileTabId()` in
 * `tabsStore.ts` — so it doubles as the model's URI path. */
export function getOrCreateModel(
  tabId: string,
  worktreeId: string,
  worktreeRoot: string,
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

  const separator = worktreeRoot.endsWith("/") || worktreeRoot.endsWith("\\") ? "" : "/";
  const absolutePath = `${worktreeRoot}${separator}${relPath}`;
  const uri = monaco.Uri.file(absolutePath);
  const language = plaintextOverride ? "plaintext" : languageForPath(relPath);
  const model = monaco.editor.createModel(content, language, uri);
  models.set(tabId, model);
  lspClientManager.attachModel(model, worktreeId, worktreeRoot);
  evictLeastRecentlyUsed();
  return model;
}

export function getModel(tabId: string): monaco.editor.ITextModel | undefined {
  return models.get(tabId);
}

export function disposeModel(tabId: string) {
  const model = models.get(tabId);
  if (model) {
    lspClientManager.detachModel(model);
    model.dispose();
    models.delete(tabId);
  }
}

registerEditorModelApi({
  get: getModel,
  dispose: disposeModel,
  didSave: (tabId) => {
    const model = getModel(tabId);
    if (model) lspClientManager.didSave(model);
  },
});
