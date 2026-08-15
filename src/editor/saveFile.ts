import { fsApi } from "../api/fs";
import { useOpenFilesStore } from "../state/openFilesStore";
import { getEditorModel, notifyEditorModelSaved } from "./modelBridge";

/** Writes the current Monaco buffer for `tabId` back to disk, guarded by
 * the mtime recorded when it was last loaded/saved — a stale mtime throws
 * (the backend's conflict error), which the caller surfaces as the
 * external-change prompt rather than silently overwriting. Returns `false`
 * if there's no in-memory model to save (nothing to do). */
export async function saveFileTab(
  tabId: string,
  worktreeRoot: string,
  filePath: string,
): Promise<boolean> {
  const model = getEditorModel(tabId);
  if (!model) return false;

  const content = model.getValue();
  const diskMtimeMs = useOpenFilesStore.getState().byTabId[tabId]?.diskMtimeMs;
  const result = await fsApi.writeFile(worktreeRoot, filePath, content, diskMtimeMs || undefined);
  useOpenFilesStore.getState().registerSaved(tabId, result.mtimeMs);
  notifyEditorModelSaved(tabId);
  return true;
}
