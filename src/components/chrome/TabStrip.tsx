import { useEffect, useMemo, useRef } from "react";
import { ArrowSquareOut, SplitHorizontal, SplitVertical, X } from "@phosphor-icons/react";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { useCloseConfirmStore } from "../../state/closeConfirmStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import { useTerminalSessionStore } from "../../state/terminalSessionStore";
import { problemSummaryForPath, useProblemsStore } from "../../state/problemsStore";
import { useTabDragStore } from "../../state/tabDragStore";
import { agentsApi } from "../../api/agents";
import { terminalApi } from "../../api/terminal";
import { disposeEditorModel } from "../../editor/modelBridge";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { ICON_SIZE } from "../../design/iconSize";
import { NewTabMenu } from "./NewTabMenu";
import { AgentBrandIcon } from "../agent/AgentBrandIcon";
import { TabContextMenu } from "./TabContextMenu";
import { registerPaneElement } from "./tabDrag";
import { useTabDrag } from "./useTabDrag";
import { detachTabToNewWindow } from "./satelliteWindows";
import styles from "./TabStrip.module.css";

/** Tears down the backend process behind a tab. Agent/terminal tabs own a
 * real backend process — closing the tab is the "last resort, kill it"
 * moment (docs/ARCHITECTURE.md §3.4), not just a UI-side removal.
 * Fire-and-forget: the tab disappears immediately either way, this just
 * ensures the process doesn't outlive it.
 *
 * Module-level rather than a closure over the pane's tabs, because bulk
 * closes ("Close Others") legitimately reach tabs the pane no longer
 * holds by the time the callback runs. */
function teardownProcess(tabId: string) {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (tab?.type === "agent") {
    void agentsApi.killAgent(tabId);
    useAgentSessionStore.getState().closeRun(tabId);
  } else if (tab?.type === "terminal") {
    void terminalApi.kill(tabId);
    useTerminalSessionStore.getState().closeSession(tabId);
  } else if (tab?.type === "file" || tab?.type === "markdown") {
    disposeEditorModel(tabId);
    useOpenFilesStore.getState().forget(tabId);
    useFileLoadStore.getState().forget(tabId);
  }
}

/** Shared by the close button and every bulk action in `TabContextMenu`
 * (Close Others/to the Right/Saved/All) — clean tabs close immediately
 * (tearing down their process first), dirty ones are batched into a
 * single confirmation dialog rather than one dialog per file. */
export function closeTabs(tabIds: string[]) {
  const dirtyByTabId = useOpenFilesStore.getState().byTabId;
  const dirtyIds = tabIds.filter((id) => dirtyByTabId[id]?.dirty);
  const cleanIds = tabIds.filter((id) => !dirtyByTabId[id]?.dirty);
  for (const id of cleanIds) {
    teardownProcess(id);
    useTabsStore.getState().closeTab(id);
  }
  if (dirtyIds.length > 0) useCloseConfirmStore.getState().request(dirtyIds, "close-tab");
}

/** One pane's tab strip. Every pane has its own — the strip is part of a
 * pane, not part of the window (docs/V2_ROADMAP.md Phase 13), which is
 * what makes a split feel like two editors rather than one editor with a
 * divided body. */
export function TabStrip({ paneId }: { paneId: string }) {
  const allTabs = useTabsStore((s) => s.tabs);
  const pane = useTabsStore((s) => s.panes[paneId]);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const focusPane = useTabsStore((s) => s.focusPane);
  const splitPane = useTabsStore((s) => s.splitPane);
  const dirtyByTabId = useOpenFilesStore((s) => s.byTabId);
  const problemsByOwner = useProblemsStore((state) => state.byOwner);
  const dragTarget = useTabDragStore((s) => s.target);
  const dragSubject = useTabDragStore((s) => s.subject);
  const stripRef = useRef<HTMLDivElement>(null);

  // Resolved here rather than by a `tabs.filter(...)` selector: an inline
  // filter returns a fresh array on every store read, which
  // `useSyncExternalStore` treats as "the store changed" on every single
  // notification (the same infinite-render trap documented on
  // `EMPTY_WORKTREES`).
  const tabIds = pane?.tabIds;
  const tabs = useMemo(() => {
    if (!tabIds) return [];
    const byId = new Map(allTabs.map((tab) => [tab.id, tab]));
    return tabIds.map((id) => byId.get(id)).filter((tab): tab is Tab => !!tab);
  }, [allTabs, tabIds]);

  useEffect(() => {
    registerPaneElement(paneId, "strip", stripRef.current);
    return () => registerPaneElement(paneId, "strip", null);
  }, [paneId]);

  const caretIndex =
    dragTarget?.kind === "reorder" && dragTarget.paneId === paneId ? dragTarget.index : null;

  return (
    <div className={styles.strip} ref={stripRef} onPointerDown={() => focusPane(paneId)}>
      <div className={styles.scroller}>
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            paneId={paneId}
            index={index}
            tabs={tabs}
            active={tab.id === activeTabId}
            dirty={dirtyByTabId[tab.id]?.dirty ?? false}
            dragging={dragSubject?.tabId === tab.id}
            caretBefore={caretIndex === index}
            problemSummary={problemSummaryForPath(
              problemsByOwner,
              tab.worktreeId,
              tab.filePath ?? "",
            )}
            dirtyByTabId={dirtyByTabId}
            onSelect={() => setActiveTab(tab.id)}
            onSplit={(edge) => splitPane(paneId, edge, tab.id)}
          />
        ))}
        {caretIndex === tabs.length && <span className={styles.dropCaret} aria-hidden />}
        <NewTabMenu paneId={paneId} />
      </div>
    </div>
  );
}

function TabItem({
  tab,
  paneId,
  index,
  tabs,
  active,
  dirty,
  dragging,
  caretBefore,
  problemSummary,
  dirtyByTabId,
  onSelect,
  onSplit,
}: {
  tab: Tab;
  paneId: string;
  index: number;
  tabs: Tab[];
  active: boolean;
  dirty: boolean;
  dragging: boolean;
  caretBefore: boolean;
  problemSummary: ReturnType<typeof problemSummaryForPath>;
  dirtyByTabId: Record<string, { dirty?: boolean } | undefined>;
  onSelect: () => void;
  onSplit: (edge: "right" | "bottom") => void;
}) {
  const visual = TAB_VISUALS[tab.type];
  const TabIcon = visual.icon;
  const onPointerDown = useTabDrag(tab, paneId);

  const otherIds = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const toRightIds = tabs.slice(index + 1).map((t) => t.id);
  const savedIds = tabs.filter((t) => !dirtyByTabId[t.id]?.dirty).map((t) => t.id);

  return (
    <>
      {caretBefore && <span className={styles.dropCaret} aria-hidden />}
      <TabContextMenu
        filePath={tab.filePath}
        onClose={() => closeTabs([tab.id])}
        onCloseOthers={() => closeTabs(otherIds)}
        onCloseToRight={() => closeTabs(toRightIds)}
        onCloseSaved={() => closeTabs(savedIds)}
        onCloseAll={() => closeTabs(tabs.map((t) => t.id))}
        hasOthers={otherIds.length > 0}
        hasToRight={toRightIds.length > 0}
        hasSaved={savedIds.length > 0}
        extraItems={[
          {
            label: "Split Right",
            icon: SplitHorizontal,
            disabled: tabs.length < 2,
            onSelect: () => onSplit("right"),
          },
          {
            label: "Split Down",
            icon: SplitVertical,
            disabled: tabs.length < 2,
            onSelect: () => onSplit("bottom"),
          },
          {
            label: "Move to New Window",
            icon: ArrowSquareOut,
            onSelect: () => void detachTabToNewWindow(tab.id),
          },
        ]}
      >
        <div
          className={styles.tab}
          data-active={active}
          data-dragging={dragging || undefined}
          data-tab-id={tab.id}
          onPointerDown={onPointerDown}
          onClick={onSelect}
          onAuxClick={(event) => {
            // Middle-click closes, matching every browser and VS Code.
            if (event.button === 1) {
              event.preventDefault();
              closeTabs([tab.id]);
            }
          }}
          role="tab"
          aria-selected={active}
          tabIndex={0}
        >
          <span className={styles.tabIndicator} />
          {tab.type === "agent" ? (
            <AgentBrandIcon
              kind={tab.agentKind ?? "claudeCode"}
              size={ICON_SIZE.md}
              color={visual.color}
            />
          ) : (
            <TabIcon size={ICON_SIZE.md} color={visual.color} />
          )}
          <span className={styles.tabTitle}>{tab.title}</span>
          {problemSummary.total > 0 && tab.filePath && (
            <span
              className={styles.problemBadge}
              data-severity={problemSummary.highestSeverity}
              title={`${problemSummary.total} problem${problemSummary.total === 1 ? "" : "s"}`}
            >
              {problemSummary.total}
            </span>
          )}
          {dirty && <span className={styles.dirtyDot} aria-label="Unsaved changes" />}
          <button
            type="button"
            className={styles.tabClose}
            aria-label={`Close ${tab.title}`}
            // The strip's drag handler lives on the tab itself, so the
            // close button has to stop the press from reaching it —
            // otherwise every close starts a drag first.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              closeTabs([tab.id]);
            }}
          >
            <X size={ICON_SIZE.xs} />
          </button>
        </div>
      </TabContextMenu>
    </>
  );
}
