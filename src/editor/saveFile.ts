import { fsApi } from "../api/fs";
import { useOpenFilesStore } from "../state/openFilesStore";
import { useUiStore } from "../state/uiStore";
import { useTabsStore } from "../state/tabsStore";
import { getEditorModel, notifyEditorModelSaved } from "./modelBridge";
import { getModel } from "./monacoModelRegistry";
import { formatModelBeforeSave } from "./formatOnSave";

/** Writes the current Monaco buffer for `tabId` back to disk, guarded by
 * the mtime recorded when it was last loaded/saved — a stale mtime throws
 * (the backend's conflict error), which the caller surfaces as the
 * external-change prompt rather than silently overwriting. Returns `false`
 * if there's no in-memory model to save (nothing to do).
 *
 * Reformats first when Settings → General → "Format on save" is on — one
 * call site for both `MonacoHost`'s autosave debounce and `AppShell`'s
 * Cmd/Ctrl+S handler, neither of which otherwise needs the real Monaco
 * model (`getEditorModel` above is this app's own lighter model
 * abstraction); `getModel` reaches into `monacoModelRegistry` for the
 * real one only when formatting actually needs it. */
export async function saveFileTab(
  tabId: string,
  worktreeRoot: string,
  filePath: string,
): Promise<boolean> {
  const model = getEditorModel(tabId);
  if (!model) return false;

  if (useUiStore.getState().formatOnSaveEnabled) {
    const realModel = getModel(tabId);
    if (realModel) await formatModelBeforeSave(realModel);
  }

  const content = model.getValue();
  const diskMtimeMs = useOpenFilesStore.getState().byTabId[tabId]?.diskMtimeMs;
  const result = await fsApi.writeFile(worktreeRoot, filePath, content, diskMtimeMs || undefined);
  useOpenFilesStore.getState().registerSaved(tabId, result.mtimeMs);
  notifyEditorModelSaved(tabId);
  return true;
}

/** Every dirty file/markdown tab across every worktree, not just the active
 * one — same "background worktrees keep running" reasoning `tabsStore.ts`
 * already applies to agent/terminal processes. A tab whose write conflicts
 * (stale mtime) surfaces the same external-change prompt the single-file
 * Cmd/Ctrl+S handler falls back to, and doesn't block the rest from saving. */
export async function saveAllDirtyTabs(): Promise<void> {
  const { tabs } = useTabsStore.getState();
  const dirtyByTabId = useOpenFilesStore.getState().byTabId;
  const targets = tabs.filter(
    (tab) =>
      (tab.type === "file" || tab.type === "markdown") &&
      tab.worktreeRoot &&
      tab.filePath &&
      dirtyByTabId[tab.id]?.dirty,
  );
  await Promise.all(
    targets.map((tab) =>
      saveFileTab(tab.id, tab.worktreeRoot!, tab.filePath!).catch(() => {
        useOpenFilesStore.getState().setExternalChangePending(tab.id, true);
      }),
    ),
  );
}
