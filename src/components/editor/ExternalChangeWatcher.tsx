import { useEffect } from "react";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useExplorerStore } from "../../state/explorerStore";
import { fsApi } from "../../api/fs";
import { listenToFsEvents } from "../../api/fsEvents";
import { getModel } from "../../editor/monacoModelRegistry";

/** Watches the active worktree for files changed on disk behind the
 * editor's back, flagging any open tab whose model is now stale.
 *
 * Extracted from `MonacoHost` when panes made that component
 * multi-instance (docs/V2_ROADMAP.md Phase 13): this is a per-worktree
 * concern, not a per-editor one, and N mounted editors would otherwise
 * register N identical listeners and re-stat every touched file N times.
 * Mounted once, by `MainContent`.
 *
 * Only re-stats files actually loaded into a Monaco model (unopened tabs
 * fetch fresh on open anyway, nothing to go stale) and only flags a real
 * mtime mismatch — that's what suppresses the false positive from the
 * watcher echoing our own save, since `registerLoaded`/`registerSaved`
 * have already updated the recorded mtime by the time that echo arrives. */
export function ExternalChangeWatcher() {
  const worktreeId = useExplorerStore((s) => s.worktreeId);
  const setExternalChangePending = useOpenFilesStore((s) => s.setExternalChangePending);

  // Registered once per worktree. Tab state is deliberately read fresh
  // from the store at event time rather than being a dependency: opening,
  // closing, or switching a tab must not tear down and re-register this
  // listener, which cost two async IPC round-trips per tab click
  // (docs/PERFORMANCE_AUDIT.md §2.1). Same "read fresh state in a
  // long-lived listener" pattern `AppShell.tsx`'s `useQuitGuard` uses.
  useEffect(() => {
    if (!worktreeId) return;
    const unlistenPromise = listenToFsEvents(worktreeId, (event) => {
      // Defensive: a malformed/partial event should skip this pass, not
      // crash the whole renderer (see `api/fsEvents.ts`).
      if (!event?.touchedPaths) return;
      const openTabs = useTabsStore.getState().tabs;
      for (const touched of event.touchedPaths) {
        const tab = openTabs.find(
          (t) => (t.type === "file" || t.type === "markdown") && t.filePath === touched,
        );
        if (!tab || !getModel(tab.id) || !tab.worktreeRoot) continue;

        void fsApi.readFile(tab.worktreeRoot, touched).then((result) => {
          if (result.kind !== "text") return;
          const recordedMtime = useOpenFilesStore.getState().byTabId[tab.id]?.diskMtimeMs;
          if (recordedMtime != null && result.mtimeMs !== recordedMtime) {
            setExternalChangePending(tab.id, true);
          }
        });
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [worktreeId, setExternalChangePending]);

  return null;
}
