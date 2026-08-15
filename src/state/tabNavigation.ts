import { useTabsStore } from "./tabsStore";
import { useWorkspaceStore } from "./workspaceStore";

/** Brings a tab into view from anywhere in the app — including a tab
 * belonging to a worktree that isn't the active one, which is the case
 * the plain `setActiveTab` can't handle on its own (the tab strip only
 * renders the active worktree's panes, so activating a background
 * worktree's tab would otherwise select something invisible).
 *
 * Lives outside `tabsStore` because it needs `workspaceStore`, and
 * `workspaceStore` already imports `tabsStore` — a module-level cycle
 * between the two stores is avoidable, so it's avoided.
 *
 * Ordering matters: selecting the worktree first, then the tab, leaves
 * `activeTabIdByWorktree` pointing at the right tab by the time
 * `useWorktreeTabSync`'s effect calls `switchToWorktree`, so the effect
 * confirms this selection instead of overwriting it. */
export function revealTab(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;

  if (tab.worktreeRoot) {
    const workspace = useWorkspaceStore.getState();
    for (const [projectId, worktrees] of Object.entries(workspace.worktreesByProject)) {
      const match = worktrees.find((worktree) => worktree.path === tab.worktreeRoot);
      if (!match) continue;
      if (match.id !== workspace.activeWorktreeId) workspace.selectWorktree(projectId, match.id);
      break;
    }
  }

  useTabsStore.getState().setActiveTab(tabId);
}
