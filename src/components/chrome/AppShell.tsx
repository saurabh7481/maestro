import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDesignSystem } from "../../design/useDesignSystem";
import { useSessionPersistence } from "../../design/useSessionPersistence";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useExplorerStore } from "../../state/explorerStore";
import { useScmStore } from "../../state/scmStore";
import { useTabsStore } from "../../state/tabsStore";
import type { Tab } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useCloseConfirmStore } from "../../state/closeConfirmStore";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { useUiStore } from "../../state/uiStore";
import { useKeybindingsStore } from "../../state/keybindingsStore";
import { comboMatchesEvent } from "../../design/keymap";
import { saveFileTab } from "../../editor/saveFile";
import { TooltipProvider } from "../primitives";
import { SettingsModal } from "../settings/SettingsModal";
import { CommandPalette } from "../command-palette/CommandPalette";
import { UnsavedChangesDialog } from "../workspace/UnsavedChangesDialog";
import { ToastHost } from "./ToastHost";
import { Titlebar } from "./Titlebar";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { ExplorerSidebar } from "./ExplorerSidebar";
import { ActivityRail } from "./ActivityRail";
import { MainContent } from "./MainContent";
import { StatusBar } from "./StatusBar";
import { ResizeHandle } from "./ResizeHandle";
import styles from "./AppShell.module.css";

const SIDEBAR_MIN_PX = 180;
const SIDEBAR_MAX_PX = 480;

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

/** Swaps the visible tab strip as the active worktree changes
 * (docs/V1_SCOPE.md §3: "Tabs are per-worktree; switching worktrees swaps
 * the tab strip"). This only changes which tab is *active* — `tabsStore`
 * keeps every worktree's tabs (and their live agent/terminal processes)
 * around regardless of which one is currently focused; see
 * `tabsStore.ts`'s `switchToWorktree`. */
function useWorktreeTabSync() {
  const activeWorktree = useActiveWorktree();
  const worktreeRoot = activeWorktree?.path;
  const switchToWorktree = useTabsStore((s) => s.switchToWorktree);

  useEffect(() => {
    switchToWorktree(worktreeRoot ?? null);
  }, [worktreeRoot, switchToWorktree]);
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
      if (!comboMatchesEvent(useKeybindingsStore.getState().comboFor("file.save"), event)) return;
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

/** Ctrl/Cmd+` opens a terminal tab for the active worktree — the new-tab
 * menu shows this as the terminal item's shortcut hint (`NewTabMenu.tsx`),
 * so it needs an actual binding somewhere; here rather than duplicated
 * inside the menu, since it should work whether or not the menu is open. */
function useTerminalShortcut() {
  const activeWorktree = useActiveWorktree();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!comboMatchesEvent(useKeybindingsStore.getState().comboFor("terminal.new"), event))
        return;
      if (!activeWorktree) return;
      event.preventDefault();
      const tab: Tab = {
        id: crypto.randomUUID(),
        type: "terminal",
        title: `Terminal — ${activeWorktree.branch}`,
        worktreeRoot: activeWorktree.path,
      };
      useTabsStore.getState().openTab(tab);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeWorktree]);
}

/** Centralized CLI availability is detected once at startup — every
 * consumer (new-tab menu, Agents & CLI settings, commit-message
 * generation) reads the shared `agentAvailabilityStore` cache rather than
 * each re-probing the CLIs on its own mount. */
function useAgentAvailabilitySync() {
  const refreshAll = useAgentAvailabilityStore((s) => s.refreshAll);
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);
}

export function AppShell() {
  useDesignSystem();
  useSessionPersistence();
  useWorktreeExplorerSync();
  useWorktreeScmSync();
  useWorktreeTabSync();
  useQuitGuard();
  useSaveShortcut();
  useTerminalShortcut();
  useAgentAvailabilitySync();

  const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
  const setLeftSidebarWidth = useUiStore((s) => s.setLeftSidebarWidth);
  const setRightSidebarWidth = useUiStore((s) => s.setRightSidebarWidth);
  const maxPx = Math.min(SIDEBAR_MAX_PX, window.innerWidth * 0.4);

  return (
    <TooltipProvider>
      <div className={styles.shell}>
        <Titlebar />
        <div className={styles.body}>
          <WorkspaceSidebar />
          <MainContent />
          <ExplorerSidebar />
          <ActivityRail />
          {leftSidebarOpen && (
            <ResizeHandle
              cssVar="--left-sidebar-width"
              edge="left"
              minPx={SIDEBAR_MIN_PX}
              maxPx={maxPx}
              getWidthRem={() => useUiStore.getState().leftSidebarWidth}
              onCommit={setLeftSidebarWidth}
            />
          )}
          {rightSidebarOpen && (
            <ResizeHandle
              cssVar="--right-sidebar-width"
              edge="right"
              minPx={SIDEBAR_MIN_PX}
              maxPx={maxPx}
              getWidthRem={() => useUiStore.getState().rightSidebarWidth}
              onCommit={setRightSidebarWidth}
            />
          )}
        </div>
        <StatusBar />
      </div>
      <SettingsModal />
      <CommandPalette />
      <UnsavedChangesDialog />
      <ToastHost />
    </TooltipProvider>
  );
}
