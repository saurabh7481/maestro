import { useEffect } from "react";
import { AgentScreen } from "../screens/AgentScreen";
import { TerminalScreen } from "../screens/TerminalScreen";
import { WorktreeSessionsPanel } from "../screens/WorktreeSessionsPanel";
import { startTabsPolling, useTabsStore } from "../state/tabsStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { Sidebar } from "./Sidebar";
import { ShellTopBar } from "./ShellTopBar";
import { TabDock } from "./TabDock";

/** The persistent app shell once paired: a sidebar (projects/worktrees —
 * off-canvas on mobile, pinned on wide viewports), a top bar, the active
 * tab's content (or the worktree's session list when no tab is active),
 * and a dock of every live session. Replaces the old sequential Projects →
 * Worktrees → Sessions → detail screen stack — see `state/workspaceStore.ts`
 * and `state/tabsStore.ts` for why. */
export function Shell() {
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const closeSidebar = useWorkspaceStore((s) => s.closeSidebar);
  const sessions = useTabsStore((s) => s.sessions);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const selectedWorktreeId = useWorkspaceStore((s) => s.selectedWorktreeId);
  const selectedWorktreeRoot = useWorkspaceStore((s) => s.selectedWorktreeRoot);
  // A tab from a worktree other than the one currently selected in the
  // sidebar is treated as inactive here rather than force-cleared on
  // worktree switch — this worktree's own sessions panel/dock take over
  // immediately, and switching back to the original worktree picks the
  // tab back up right where it was, same as the desktop's own per-worktree
  // tab strip. Keyed on `worktreeRoot`, not `worktreeId` — see
  // `workspaceStore.ts`'s `selectedWorktreeRoot` doc comment.
  const active = sessions.find((s) => s.id === activeTabId);
  const activeSession = active?.worktreeRoot === selectedWorktreeRoot ? active : null;

  useEffect(() => startTabsPolling(), []);

  return (
    <div className="shell">
      <Sidebar />
      {sidebarOpen && <div className="sidebar-backdrop" onClick={closeSidebar} />}
      <div className="shell-main">
        <ShellTopBar />
        <div className="shell-content">
          {activeSession?.kind === "agent" && (
            <AgentScreen key={activeSession.id} runId={activeSession.id} />
          )}
          {activeSession?.kind === "terminal" && (
            <TerminalScreen key={activeSession.id} terminalId={activeSession.id} />
          )}
          {!activeSession && <WorktreeSessionsPanel key={selectedWorktreeId ?? "none"} />}
        </div>
        <TabDock />
      </div>
    </div>
  );
}
