import { Robot, Terminal as TerminalIcon } from "@phosphor-icons/react";
import { useTabsStore } from "../state/tabsStore";
import { useWorkspaceStore } from "../state/workspaceStore";

/** Every live session *in the currently selected worktree*, agent and
 * terminal alike — tap any to switch straight to it. Scoped the same way
 * the desktop's own tab strip is (one worktree's tabs at a time, see
 * `workspaceStore.ts`'s `selectedWorktreeRoot` doc comment for why this
 * filters on `worktreeRoot`, not `worktreeId`) rather than showing every
 * session across every project at once. No per-chip close: this dock
 * mirrors real running sessions (`state/tabsStore.ts` polls them), so
 * "closing" one here would either do nothing meaningful or have to mean
 * "kill it", which stays an explicit action in `ShellTopBar.tsx` instead
 * of a stray tap target here. */
export function TabDock() {
  const allSessions = useTabsStore((s) => s.sessions);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActive = useTabsStore((s) => s.setActive);
  const selectedWorktreeRoot = useWorkspaceStore((s) => s.selectedWorktreeRoot);

  const sessions = allSessions.filter((s) => s.worktreeRoot === selectedWorktreeRoot);
  if (sessions.length === 0) return null;

  return (
    <div className="tab-dock">
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          className="tab-chip"
          data-active={session.id === activeTabId || undefined}
          onClick={() => setActive(session.id)}
        >
          {session.kind === "agent" ? (
            <Robot size={14} weight="fill" />
          ) : (
            <TerminalIcon size={14} weight="fill" />
          )}
          <span className="tab-chip-label">{session.label}</span>
        </button>
      ))}
    </div>
  );
}
