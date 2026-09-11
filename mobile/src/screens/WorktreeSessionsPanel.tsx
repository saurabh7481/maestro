import { useState } from "react";
import {
  Plus,
  Robot,
  Sidebar as SidebarIcon,
  Stack,
  Terminal as TerminalIcon,
} from "@phosphor-icons/react";
import { EmptyState } from "../components/EmptyState";
import { NewAgentSheet } from "../components/NewAgentSheet";
import { useAuthStore } from "../state/authStore";
import { useTabsStore } from "../state/tabsStore";
import { useWorkspaceStore } from "../state/workspaceStore";

/** The shell's default main-content view: this worktree's sessions,
 * filtered from the same globally-polled list the tab dock uses
 * (`state/tabsStore.ts`) — one poll, two views, so there's no separate
 * per-worktree fetch to fall out of step with it. */
export function WorktreeSessionsPanel() {
  const worktreeId = useWorkspaceStore((s) => s.selectedWorktreeId);
  const worktreeRoot = useWorkspaceStore((s) => s.selectedWorktreeRoot);
  const openSidebar = useWorkspaceStore((s) => s.openSidebar);
  const allSessions = useTabsStore((s) => s.sessions);
  const setActive = useTabsStore((s) => s.setActive);
  const refresh = useTabsStore((s) => s.refresh);
  const canWrite = useAuthStore((s) => s.accessLevel === "write");

  const [showNewAgent, setShowNewAgent] = useState(false);

  if (!worktreeId) {
    return (
      <div className="screen-body">
        <div className="empty-state" style={{ minHeight: "100%" }}>
          <button type="button" className="btn btn-secondary" onClick={openSidebar}>
            <SidebarIcon size={15} />
            Choose a project
          </button>
          <div className="empty-state-detail">
            Pick a project and worktree from the sidebar to see its sessions.
          </div>
        </div>
      </div>
    );
  }

  // Keyed on `worktreeRoot`, not `worktreeId` — a terminal session's
  // `worktreeId` is always `null` (see `workspaceStore.ts`'s
  // `selectedWorktreeRoot` doc comment), so id-based filtering silently
  // dropped every terminal from this list.
  const sessions = allSessions.filter((s) => s.worktreeRoot === worktreeRoot);

  return (
    <>
      <div className="screen-body">
        {sessions.length === 0 && (
          <EmptyState
            icon={Stack}
            title="No active sessions"
            detail="Start a new agent to begin, or open an existing terminal from the desktop app."
          />
        )}
        {sessions.length > 0 && (
          <div className="list">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="list-row"
                onClick={() => setActive(session.id)}
              >
                <span className="list-row-icon">
                  {session.kind === "agent" ? (
                    <Robot size={17} weight="fill" />
                  ) : (
                    <TerminalIcon size={17} weight="fill" />
                  )}
                </span>
                <span className="list-row-body">
                  <div className="list-row-title">{session.label}</div>
                  {session.detail && <div className="list-row-detail">{session.detail}</div>}
                </span>
                <span className="status-dot" data-status={session.status} />
              </button>
            ))}
          </div>
        )}
      </div>
      {canWrite && (
        <button
          type="button"
          className="fab"
          aria-label="New agent"
          onClick={() => setShowNewAgent(true)}
        >
          <Plus size={24} weight="bold" />
        </button>
      )}
      {showNewAgent && (
        <NewAgentSheet
          worktreeId={worktreeId}
          onClose={() => setShowNewAgent(false)}
          onCreated={(runId) => {
            setShowNewAgent(false);
            void refresh().then(() => setActive(runId));
          }}
        />
      )}
    </>
  );
}
