import { useEffect } from "react";
import { useTabsStore } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { PaneGroup } from "./PaneGroup";
import { TabHost } from "./TabHost";
import { TabDragGhost } from "./TabDragGhost";
import { ExternalChangeWatcher } from "../editor/ExternalChangeWatcher";
import styles from "./MainContent.module.css";

/** The editor area: one worktree's pane tree, plus the two things that
 * deliberately live *outside* it — `TabHost` (which keeps process-backed
 * tabs mounted across pane moves) and the drag ghost.
 *
 * Only the active worktree's tree renders. Background worktrees keep
 * their tabs, panes and processes in the store, exactly as before
 * (docs/V1_SCOPE.md §3), and their mounted tabs park in `TabHost` rather
 * than being torn down. */
export function MainContent() {
  const activeWorktree = useActiveWorktree();
  const worktreeKey = activeWorktree?.path ?? "";
  const layout = useTabsStore((s) => s.layouts[worktreeKey]);
  const ensurePaneForWorktree = useTabsStore((s) => s.ensurePaneForWorktree);

  // A worktree with nothing open still needs one pane — otherwise there's
  // no tab strip, and therefore no `+` button to open the first tab with.
  useEffect(() => {
    ensurePaneForWorktree(activeWorktree?.path);
  }, [activeWorktree?.path, ensurePaneForWorktree]);

  return (
    <div className={styles.main}>
      {layout && <PaneGroup node={layout} worktreeKey={worktreeKey} />}
      <TabHost />
      <TabDragGhost />
      <ExternalChangeWatcher />
    </div>
  );
}
