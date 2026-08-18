import { lazy, Suspense, useEffect, useRef } from "react";
import { Stack } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { usePaneSlotStore } from "../../state/paneSlotStore";
import { useTabDragStore } from "../../state/tabDragStore";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { TabStrip } from "./TabStrip";
import { registerPaneElement } from "./tabDrag";
import { MarkdownPane } from "../editor/MarkdownPane";
import { BinaryFileView } from "../editor/BinaryFileView";
import { TooLargeFileView } from "../editor/TooLargeFileView";
import { ExternalChangeBanner } from "../editor/ExternalChangeBanner";
import styles from "./PaneView.module.css";

const NOTE: Record<string, string> = {
  diff: "Open a diff from Source Control or History to review it here.",
};

const MonacoHost = lazy(() =>
  import("../editor/MonacoHost").then((module) => ({ default: module.MonacoHost })),
);
const DiffView = lazy(() =>
  import("../diff/DiffView").then((module) => ({ default: module.DiffView })),
);
const ProcessManagerTab = lazy(() =>
  import("../processes/ProcessManagerTab").then((module) => ({
    default: module.ProcessManagerTab,
  })),
);
const ReviewView = lazy(() =>
  import("../diff/ReviewView").then((module) => ({ default: module.ReviewView })),
);
const MergeView = lazy(() =>
  import("../diff/MergeView").then((module) => ({ default: module.MergeView })),
);

/** One editor pane: a tab strip, and under it whatever its active tab
 * shows. Everything here used to live in `MainContent` as the single
 * editor area; splitting (docs/V2_ROADMAP.md Phase 13) makes it a
 * component that can exist several times over, which is why nothing in it
 * reads the *global* active tab any more — a pane renders its own active
 * tab whether or not the window's focus is in it. */
export function PaneView({ paneId }: { paneId: string }) {
  const pane = useTabsStore((s) => s.panes[paneId]);
  const activeTabId = pane?.activeTabId ?? null;
  const activeTab = useTabsStore((s) =>
    activeTabId ? s.tabs.find((tab) => tab.id === activeTabId) : undefined,
  );
  const dragTarget = useTabDragStore((s) => s.target);
  const dragging = useTabDragStore((s) => s.subject !== null);

  const contentRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const registerSlot = usePaneSlotStore((s) => s.register);
  const unregisterSlot = usePaneSlotStore((s) => s.unregister);

  useEffect(() => {
    registerPaneElement(paneId, "content", contentRef.current);
    return () => registerPaneElement(paneId, "content", null);
  }, [paneId]);

  useEffect(() => {
    if (slotRef.current) registerSlot(paneId, slotRef.current);
    return () => unregisterSlot(paneId);
  }, [paneId, registerSlot, unregisterSlot]);

  const isEditorTab = activeTab?.type === "file" || activeTab?.type === "markdown";
  // A restored/background file tab must not load the editor while the user
  // is working in an agent or terminal. Monaco's module and models stay
  // cached after their first use, so returning to an editor stays quick.
  const monacoNeeded = isEditorTab;

  const loadState = useFileLoadStore((s) => (activeTab ? s.byTabId[activeTab.id] : undefined));
  const externalChangePending = useOpenFilesStore((s) =>
    activeTab ? (s.byTabId[activeTab.id]?.externalChangePending ?? false) : false,
  );
  const isRealDiffTab = activeTab?.type === "diff" && !!activeTab.filePath && !!activeTab.diffMode;

  const dropHere = dragTarget?.paneId === paneId ? dragTarget : null;

  return (
    <div className={styles.pane}>
      <TabStrip paneId={paneId} />
      <div className={styles.content} ref={contentRef}>
        {/* Before `MonacoHost`, not after: both are in the content
            column's flex flow, and in Source mode the markdown tab's
            Source/Preview header has to sit above the editor. */}
        {activeTab?.type === "markdown" && <MarkdownPane tab={activeTab} />}

        {monacoNeeded && (
          <Suspense fallback={null}>
            <MonacoHost tabId={activeTabId} />
          </Suspense>
        )}

        {isEditorTab && loadState?.kind === "loading" && (
          <div className={styles.loading}>Loading…</div>
        )}
        {isEditorTab && loadState?.kind === "binary" && (
          <BinaryFileView sizeBytes={loadState.sizeBytes} />
        )}
        {isEditorTab && loadState?.kind === "tooLarge" && (
          <TooLargeFileView sizeBytes={loadState.sizeBytes} />
        )}
        {isEditorTab && loadState?.kind === "error" && (
          <div className={styles.placeholder}>
            <div className={styles.placeholderTitle}>Couldn't open file</div>
            <div className={styles.placeholderNote}>{loadState.message}</div>
          </div>
        )}

        {isEditorTab && externalChangePending && activeTab.worktreeRoot && activeTab.filePath && (
          <ExternalChangeBanner
            tabId={activeTab.id}
            worktreeRoot={activeTab.worktreeRoot}
            filePath={activeTab.filePath}
          />
        )}

        {isRealDiffTab && activeTab && (
          <Suspense fallback={<div className={styles.loading}>Loading diff…</div>}>
            <DiffView key={activeTab.id} tab={activeTab} />
          </Suspense>
        )}

        {activeTab?.type === "processes" && (
          <Suspense fallback={<div className={styles.loading}>Loading processes…</div>}>
            <ProcessManagerTab />
          </Suspense>
        )}

        {activeTab?.type === "review" && (
          <Suspense fallback={<div className={styles.loading}>Loading review…</div>}>
            <ReviewView key={activeTab.id} tab={activeTab} />
          </Suspense>
        )}

        {activeTab?.type === "merge" && activeTab.filePath && (
          <Suspense fallback={<div className={styles.loading}>Loading merge editor…</div>}>
            <MergeView key={activeTab.id} tab={activeTab} />
          </Suspense>
        )}

        {/* Agent and terminal tabs are portalled in here by `TabHost`,
            which stays mounted at the shell level so they survive moving
            between panes (see `state/paneSlotStore.ts`). */}
        <div className={styles.slot} ref={slotRef} />

        {activeTab &&
          !isEditorTab &&
          !isRealDiffTab &&
          activeTab.type !== "agent" &&
          activeTab.type !== "terminal" &&
          activeTab.type !== "review" &&
          activeTab.type !== "merge" &&
          activeTab.type !== "processes" && (
            <div className={styles.placeholder}>
              <div className={styles.placeholderIcon}>
                {(() => {
                  const Icon = TAB_VISUALS[activeTab.type].icon;
                  return <Icon size={26} color={TAB_VISUALS[activeTab.type].color} />;
                })()}
              </div>
              <div className={styles.placeholderTitle}>{activeTab.title}</div>
              <div className={styles.placeholderNote}>{NOTE[activeTab.type]}</div>
            </div>
          )}

        {!activeTab && (
          <div className={styles.empty}>
            <Stack size={32} />
            <span>No tabs open — press the + button to start one.</span>
          </div>
        )}

        {/* Drop preview: the half of the pane a split would take, or the
            whole pane for a plain move into it. Drawn over the content so
            it reads against a terminal or an editor alike. */}
        {dragging && dropHere && (
          <div
            className={styles.dropPreview}
            data-edge={dropHere.kind === "split" ? dropHere.edge : "all"}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
