import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertDialog } from "../primitives";
import { useCloseConfirmStore } from "../../state/closeConfirmStore";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { disposeEditorModel } from "../../editor/modelBridge";

/** The single "discard unsaved changes?" confirmation, reused for both
 * closing one dirty tab and quitting with any dirty tabs open — driven by
 * `closeConfirmStore` so neither `TabStrip` nor `AppShell`'s
 * `onCloseRequested` listener need their own dialog state. */
export function UnsavedChangesDialog() {
  const pendingTabIds = useCloseConfirmStore((s) => s.pendingTabIds);
  const intent = useCloseConfirmStore((s) => s.intent);
  const clear = useCloseConfirmStore((s) => s.clear);
  const tabs = useTabsStore((s) => s.tabs);
  const closeTab = useTabsStore((s) => s.closeTab);
  const forgetOpenFile = useOpenFilesStore((s) => s.forget);
  const forgetLoadState = useFileLoadStore((s) => s.forget);

  const open = !!pendingTabIds && pendingTabIds.length > 0;
  const titles = pendingTabIds
    ?.map((id) => tabs.find((t) => t.id === id)?.title)
    .filter((t): t is string => !!t);

  function discard() {
    if (!pendingTabIds) return;
    for (const id of pendingTabIds) {
      disposeEditorModel(id);
      forgetOpenFile(id);
      forgetLoadState(id);
      if (intent === "close-tab") closeTab(id);
    }
    const wasQuit = intent === "quit";
    clear();
    if (wasQuit) void getCurrentWindow().destroy();
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !next && clear()}
      title={
        titles && titles.length === 1
          ? `Discard changes to "${titles[0]}"?`
          : `Discard changes to ${titles?.length ?? 0} files?`
      }
      description={
        titles && titles.length === 1
          ? "Unsaved changes will be lost."
          : `Unsaved changes in ${titles?.join(", ")} will be lost.`
      }
      confirmLabel="Discard changes"
      destructive
      onConfirm={discard}
    />
  );
}
