import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLineLeft, Minus, Square, X } from "@phosphor-icons/react";
import { useDesignSystem } from "../../design/useDesignSystem";
import { useTabsStore } from "../../state/tabsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { TooltipProvider } from "../primitives";
import { ToastHost } from "./ToastHost";
import { PaneGroup } from "./PaneGroup";
import { TabHost } from "./TabHost";
import { TabDragGhost } from "./TabDragGhost";
import { dockAllToMainWindow, requestHandover } from "./satelliteWindows";
import styles from "./SatelliteShell.module.css";

/** A detached window's shell (docs/V2_ROADMAP.md Phase 13).
 *
 * Deliberately a *reduced* copy of `AppShell`, not a second full one: no
 * workspace sidebar, no explorer, no activity rail, no status bar. A
 * detached window exists to watch one thing on another monitor — the
 * roadmap's own framing — so it carries only what a tab needs to work:
 * the pane tree (so you can still split and reorder inside it),
 * `TabHost`, and a titlebar with a dock-back button.
 *
 * The tabs themselves are handed over by the main window
 * (`satelliteWindows.ts`); the processes behind them never move. */
export function SatelliteShell() {
  useDesignSystem();
  const [ready, setReady] = useState(false);
  const adoptTabs = useTabsStore((s) => s.adoptTabs);
  const layouts = useTabsStore((s) => s.layouts);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);

  // The worktree list is loaded here for the same reason the main window
  // loads it: tab components label themselves with the branch they belong
  // to. CLI availability drives the agent tab's own "is this installed"
  // banner. Neither is a second source of truth — both are read-only
  // caches over the same backend the main window reads.
  useEffect(() => {
    void useWorkspaceStore.getState().loadAll();
    void useAgentAvailabilityStore.getState().refreshAll();
  }, []);

  useEffect(() => {
    const stop = requestHandover((handover) => {
      adoptTabs(handover.tabs);
      if (handover.activeTabId) setActiveTab(handover.activeTabId);
      setReady(true);
    });
    return stop;
  }, [adoptTabs, setActiveTab]);

  // Closing a detached window returns its tabs rather than stranding
  // their processes with no visible tab anywhere. `destroy()` inside
  // `dockAllToMainWindow` is what actually closes it, after the main
  // window has been told what it's getting.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void dockAllToMainWindow();
      })
      .then((stop) => {
        unlisten = stop;
      });
    return () => unlisten?.();
  }, []);

  // A satellite holds exactly one worktree bucket's worth of tabs — the
  // tabs it was handed. Whichever layout exists is the one to render.
  const worktreeKey = Object.keys(layouts)[0];
  const layout = worktreeKey != null ? layouts[worktreeKey] : undefined;

  return (
    <TooltipProvider>
      <div className={styles.shell}>
        <div className={styles.titlebar} data-tauri-drag-region>
          <span className={styles.label} data-tauri-drag-region>
            Maestro — detached
          </span>
          <div className={styles.spacer} data-tauri-drag-region />
          <button
            type="button"
            className={styles.dock}
            onClick={() => void dockAllToMainWindow()}
            title="Move these tabs back to the main window"
          >
            <ArrowLineLeft size={13} />
            Dock to main
          </button>
          <div className={styles.windowControls}>
            <button
              type="button"
              className={styles.control}
              aria-label="Minimize"
              onClick={() => void getCurrentWindow().minimize()}
            >
              <Minus size={12} />
            </button>
            <button
              type="button"
              className={styles.control}
              aria-label="Maximize"
              onClick={() => void getCurrentWindow().toggleMaximize()}
            >
              <Square size={10} />
            </button>
            <button
              type="button"
              className={`${styles.control} ${styles.close}`}
              aria-label="Close"
              onClick={() => void getCurrentWindow().close()}
            >
              <X size={12} />
            </button>
          </div>
        </div>

        <div className={styles.body}>
          {layout ? (
            <PaneGroup node={layout} worktreeKey={worktreeKey!} />
          ) : (
            <div className={styles.waiting}>{ready ? "No tabs in this window." : "Moving…"}</div>
          )}
          <TabHost />
          <TabDragGhost />
        </div>
      </div>
      <ToastHost />
    </TooltipProvider>
  );
}
