import { processesTabId, useTabsStore } from "../../state/tabsStore";
import { activeWorktreeOf, useWorkspaceStore } from "../../state/workspaceStore";

/** Opens (or focuses) the Process Manager tab. Shared by the new-tab
 * menu, the command palette and the status-bar popover so all three land
 * on the same tab instead of each opening its own.
 *
 * The tab is scoped to the active worktree like every other tab — its
 * *contents* are global (every process, every project), but the tab strip
 * it lives in is per-worktree, so its id is too. */
export function openProcessesTab(): void {
  const worktree = activeWorktreeOf(useWorkspaceStore.getState());
  useTabsStore.getState().ensureTab({
    id: processesTabId(worktree?.path),
    type: "processes",
    title: "Processes",
    worktreeRoot: worktree?.path,
    worktreeId: worktree?.id,
  });
}
