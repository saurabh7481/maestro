import { useMemo } from "react";
import { X } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useCloseConfirmStore } from "../../state/closeConfirmStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import { useTerminalSessionStore } from "../../state/terminalSessionStore";
import { agentsApi } from "../../api/agents";
import { terminalApi } from "../../api/terminal";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { ICON_SIZE } from "../../design/iconSize";
import { NewTabMenu } from "./NewTabMenu";
import { TabContextMenu } from "./TabContextMenu";
import styles from "./TabStrip.module.css";

export function TabStrip() {
  const allTabs = useTabsStore((s) => s.tabs);
  const activeWorktree = useActiveWorktree();
  // Scoped to the active worktree (docs/V1_SCOPE.md §3) — background
  // worktrees' tabs stay in `tabsStore` (their agent/terminal processes
  // keep running) but aren't rendered here. Filtered outside the zustand
  // selector, in a `useMemo`, rather than inline in `useStore((s) =>
  // s.tabs.filter(...))` — an inline filter returns a fresh array every
  // read, which `useSyncExternalStore` treats as "the store changed" on
  // every single notification, not just tab changes (the same infinite-
  // render trap documented on `EMPTY_WORKTREES`/`EMPTY_ATTACHMENTS`).
  const worktreeRoot = activeWorktree?.path ?? "";
  const tabs = useMemo(
    () => allTabs.filter((t) => (t.worktreeRoot ?? "") === worktreeRoot),
    [allTabs, worktreeRoot],
  );
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const dirtyByTabId = useOpenFilesStore((s) => s.byTabId);
  const requestClose = useCloseConfirmStore((s) => s.request);
  const closeAgentRun = useAgentSessionStore((s) => s.closeRun);
  const closeTerminalSession = useTerminalSessionStore((s) => s.closeSession);

  /** Agent/terminal tabs own a real backend process — closing the tab is
   * the "last resort, kill it" moment (docs/ARCHITECTURE.md §3.4), not
   * just a UI-side removal. Fire-and-forget: the tab disappears
   * immediately either way, this just ensures the process doesn't
   * outlive it. */
  function teardownProcess(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.type === "agent") {
      void agentsApi.killAgent(tabId);
      closeAgentRun(tabId);
    } else if (tab?.type === "terminal") {
      void terminalApi.kill(tabId);
      closeTerminalSession(tabId);
    }
  }

  function handleClose(tabId: string) {
    closeMany([tabId]);
  }

  /** Shared by the close button and every bulk action in `TabContextMenu`
   * (Close Others/to the Right/Saved/All) — clean tabs close immediately
   * (tearing down their process first), dirty ones are batched into a
   * single confirmation dialog rather than one dialog per file. */
  function closeMany(tabIds: string[]) {
    const dirtyIds = tabIds.filter((id) => dirtyByTabId[id]?.dirty);
    const cleanIds = tabIds.filter((id) => !dirtyByTabId[id]?.dirty);
    for (const id of cleanIds) {
      teardownProcess(id);
      closeTab(id);
    }
    if (dirtyIds.length > 0) requestClose(dirtyIds, "close-tab");
  }

  return (
    <div className={styles.strip}>
      <div className={styles.scroller}>
        {tabs.map((tab, index) => {
          const visual = TAB_VISUALS[tab.type];
          const TabIcon = visual.icon;
          const isActive = tab.id === activeTabId;
          const isDirty = dirtyByTabId[tab.id]?.dirty ?? false;
          const otherIds = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
          const toRightIds = tabs.slice(index + 1).map((t) => t.id);
          const savedIds = tabs.filter((t) => !dirtyByTabId[t.id]?.dirty).map((t) => t.id);
          return (
            <TabContextMenu
              key={tab.id}
              filePath={tab.filePath}
              onClose={() => closeMany([tab.id])}
              onCloseOthers={() => closeMany(otherIds)}
              onCloseToRight={() => closeMany(toRightIds)}
              onCloseSaved={() => closeMany(savedIds)}
              onCloseAll={() => closeMany(tabs.map((t) => t.id))}
              hasOthers={otherIds.length > 0}
              hasToRight={toRightIds.length > 0}
              hasSaved={savedIds.length > 0}
            >
              <div
                className={styles.tab}
                data-active={isActive}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
              >
                <span className={styles.tabIndicator} />
                <TabIcon size={ICON_SIZE.md} color={visual.color} />
                <span className={styles.tabTitle}>{tab.title}</span>
                {isDirty && <span className={styles.dirtyDot} aria-label="Unsaved changes" />}
                <button
                  type="button"
                  className={styles.tabClose}
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClose(tab.id);
                  }}
                >
                  <X size={ICON_SIZE.xs} />
                </button>
              </div>
            </TabContextMenu>
          );
        })}
        <NewTabMenu />
      </div>
    </div>
  );
}
