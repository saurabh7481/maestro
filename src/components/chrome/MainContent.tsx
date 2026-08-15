import { lazy, Suspense } from "react";
import { Stack } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { TabStrip } from "./TabStrip";
import { MarkdownPane } from "../editor/MarkdownPane";
import { BinaryFileView } from "../editor/BinaryFileView";
import { TooLargeFileView } from "../editor/TooLargeFileView";
import { ExternalChangeBanner } from "../editor/ExternalChangeBanner";
import { AgentTab } from "../agent/AgentTab";
import { TerminalTab } from "../terminal/TerminalTab";
import styles from "./MainContent.module.css";

const NOTE: Record<string, string> = {
  diff: "Open a diff from Source Control or History to review it here.",
};

const MonacoHost = lazy(() =>
  import("../editor/MonacoHost").then((module) => ({ default: module.MonacoHost })),
);
const DiffView = lazy(() =>
  import("../diff/DiffView").then((module) => ({ default: module.DiffView })),
);

export function MainContent() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isEditorTab = activeTab?.type === "file" || activeTab?.type === "markdown";

  // A restored/background file tab must not load the editor while the user is
  // working in an agent or terminal. Monaco's module and models stay cached
  // after their first use, so returning to an editor remains quick.
  const monacoNeeded = isEditorTab;

  const loadState = useFileLoadStore((s) => (activeTab ? s.byTabId[activeTab.id] : undefined));
  const externalChangePending = useOpenFilesStore((s) =>
    activeTab ? (s.byTabId[activeTab.id]?.externalChangePending ?? false) : false,
  );

  const isRealDiffTab = activeTab?.type === "diff" && !!activeTab.filePath && !!activeTab.diffMode;

  return (
    <div className={styles.main}>
      <TabStrip />
      <div className={styles.content}>
        {monacoNeeded && (
          <Suspense fallback={null}>
            <MonacoHost />
          </Suspense>
        )}

        {activeTab?.type === "markdown" && <MarkdownPane tab={activeTab} />}

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

        {activeTab?.type === "agent" && <AgentTab key={activeTab.id} tab={activeTab} />}
        {activeTab?.type === "terminal" && activeTab.worktreeRoot && (
          <TerminalTab key={activeTab.id} tab={activeTab} />
        )}

        {activeTab &&
          !isEditorTab &&
          !isRealDiffTab &&
          activeTab.type !== "agent" &&
          activeTab.type !== "terminal" && (
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
      </div>
    </div>
  );
}
