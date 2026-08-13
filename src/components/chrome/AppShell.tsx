import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDesignSystem } from "../../design/useDesignSystem";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useExplorerStore } from "../../state/explorerStore";
import { useScmStore } from "../../state/scmStore";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useCloseConfirmStore } from "../../state/closeConfirmStore";
import { saveFileTab } from "../../editor/saveFile";
import { TooltipProvider } from "../primitives";
import { SettingsModal } from "../settings/SettingsModal";
import { CommandPalette } from "../command-palette/CommandPalette";
import { UnsavedChangesDialog } from "../workspace/UnsavedChangesDialog";
import { Titlebar } from "./Titlebar";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { ExplorerSidebar } from "./ExplorerSidebar";
import { ActivityRail } from "./ActivityRail";
import { MainContent } from "./MainContent";
import { StatusBar } from "./StatusBar";
import styles from "./AppShell.module.css";

/** Starts/stops the file watcher as the active worktree changes — one
 * live watcher at a time (docs/ROADMAP.md Phase 3), not one per worktree. */
function useWorktreeExplorerSync() {
  const activeWorktree = useActiveWorktree();
  const worktreeId = activeWorktree?.id;
  const worktreeRoot = activeWorktree?.path;
  const openForWorktree = useExplorerStore((s) => s.openForWorktree);
  const closeWorktree = useExplorerStore((s) => s.closeWorktree);

  useEffect(() => {
    if (worktreeId && worktreeRoot) {
      void openForWorktree(worktreeId, worktreeRoot);
    } else {
      void closeWorktree();
    }
  }, [worktreeId, worktreeRoot, openForWorktree, closeWorktree]);
}

/** Subscribes `scmStore` to the active worktree, independent of
 * `useWorktreeExplorerSync` above — `scmStore` doesn't own a watcher
 * lifecycle of its own (it rides the one `explorerStore` already starts),
 * so this just opens/closes its `scm://` listener and initial status
 * fetch in step with the active worktree. */
function useWorktreeScmSync() {
  const activeWorktree = useActiveWorktree();
  const worktreeId = activeWorktree?.id;
  const worktreeRoot = activeWorktree?.path;
  const openForWorktree = useScmStore((s) => s.openForWorktree);
  const closeWorktree = useScmStore((s) => s.closeWorktree);

  useEffect(() => {
    if (worktreeId && worktreeRoot) {
      void openForWorktree(worktreeId, worktreeRoot);
    } else {
      void closeWorktree();
    }
  }, [worktreeId, worktreeRoot, openForWorktree, closeWorktree]);
}

/** Single `onCloseRequested` listener covering the titlebar close button,
 * OS window-manager close, and Cmd/Ctrl+Q alike (they all funnel through
 * this one Tauri event) — blocks the close and routes to the shared
 * unsaved-changes dialog if any tab is dirty. Reads store state fresh at
 * event time (`.getState()`) rather than from a captured closure, since
 * the listener is registered once. */
function useQuitGuard() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        const dirtyTabIds = Object.entries(useOpenFilesStore.getState().byTabId)
          .filter(([, meta]) => meta.dirty)
          .map(([id]) => id);
        if (dirtyTabIds.length > 0) {
          event.preventDefault();
          useCloseConfirmStore.getState().request(dirtyTabIds, "quit");
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);
}

/** Cmd/Ctrl+S saves the active tab if it's a dirty file/markdown tab. A
 * write conflict (file changed on disk since load) surfaces as the same
 * external-change banner a watcher-detected change would. */
function useSaveShortcut() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      const { tabs, activeTabId } = useTabsStore.getState();
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab || (tab.type !== "file" && tab.type !== "markdown")) return;
      if (!tab.worktreeRoot || !tab.filePath) return;
      event.preventDefault();
      if (!useOpenFilesStore.getState().byTabId[tab.id]?.dirty) return;

      void saveFileTab(tab.id, tab.worktreeRoot, tab.filePath).catch(() => {
        useOpenFilesStore.getState().setExternalChangePending(tab.id, true);
      });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function AppShell() {
  useDesignSystem();
  useWorktreeExplorerSync();
  useWorktreeScmSync();
  useQuitGuard();
  useSaveShortcut();

  return (
    <TooltipProvider>
      <div className={styles.shell}>
        <Titlebar />
        <div className={styles.body}>
          <WorkspaceSidebar />
          <MainContent />
          <ExplorerSidebar />
          <ActivityRail />
        </div>
        <StatusBar />
      </div>
      <SettingsModal />
      <CommandPalette />
      <UnsavedChangesDialog />
    </TooltipProvider>
  );
}
