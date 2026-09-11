import { List, Skull, Stop } from "@phosphor-icons/react";
import { useAgentStore } from "../state/agentStore";
import { useAuthStore } from "../state/authStore";
import { useTabsStore } from "../state/tabsStore";
import { useWorkspaceStore } from "../state/workspaceStore";

export function ShellTopBar() {
  const openSidebar = useWorkspaceStore((s) => s.openSidebar);
  const worktreeLabel = useWorkspaceStore((s) => s.selectedWorktreeLabel);
  const sessions = useTabsStore((s) => s.sessions);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeSession = sessions.find((s) => s.id === activeTabId) ?? null;
  const runStatus = useAgentStore((s) =>
    activeSession?.kind === "agent" ? s.byRunId[activeSession.id]?.status : undefined,
  );
  const streamStatus = useAgentStore((s) =>
    activeSession?.kind === "agent" ? s.streamStatusByRunId[activeSession.id] : undefined,
  );
  const interrupt = useAgentStore((s) => s.interrupt);
  const kill = useAgentStore((s) => s.kill);
  const setActive = useTabsStore((s) => s.setActive);
  const canWrite = useAuthStore((s) => s.accessLevel === "write");

  const working = runStatus === "working" || runStatus === "settling";

  const title = activeSession?.label ?? worktreeLabel ?? "Maestro";
  const subtitle = activeSession
    ? activeSession.kind === "terminal"
      ? "Terminal"
      : runStatus === "awaitingPermission"
        ? "Waiting for approval"
        : working
          ? "Working…"
          : runStatus === "error"
            ? "Error"
            : streamStatus === "connecting"
              ? "Reconnecting…"
              : "Idle"
    : worktreeLabel
      ? "Sessions"
      : undefined;

  async function handleKill() {
    if (!activeSession) return;
    if (!window.confirm(`Kill "${activeSession.label}"? This stops the agent process.`)) return;
    await kill(activeSession.id);
    setActive(null);
  }

  return (
    <div className="topbar">
      <button
        type="button"
        className="topbar-back sidebar-toggle"
        onClick={openSidebar}
        aria-label="Menu"
      >
        <List size={18} weight="bold" />
      </button>
      <div className="topbar-titles">
        <div className="topbar-title">{title}</div>
        {subtitle && <div className="topbar-subtitle">{subtitle}</div>}
      </div>
      {activeSession?.kind === "agent" && canWrite && (
        <div className="topbar-actions">
          {working && (
            <button
              type="button"
              className="icon-button"
              aria-label="Interrupt"
              onClick={() => void interrupt(activeSession.id)}
            >
              <Stop size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Kill"
            onClick={() => void handleKill()}
          >
            <Skull size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
