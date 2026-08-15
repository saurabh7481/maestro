import {
  ArrowsClockwise,
  Bell,
  CircleHalf,
  GitBranch,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useTabsStore } from "../../state/tabsStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import { THEME_LABELS } from "../../design/themes";
import styles from "./StatusBar.module.css";

/** Reflects whatever's actually happening in the active tab — an agent
 * tab's real run status, not a fixed placeholder. Renders nothing for any
 * other tab type (file/diff/terminal) rather than showing a stale or
 * made-up agent status. */
function ActiveTabStatus() {
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const runState = useAgentSessionStore((s) =>
    activeTab?.type === "agent" ? s.byRunId[activeTab.id] : undefined,
  );

  if (!activeTab || activeTab.type !== "agent" || !activeTab.agentKind) return null;

  const status = runState?.status ?? "idle";
  const label = AGENT_DISPLAY_NAME[activeTab.agentKind];

  if (status === "error") {
    return (
      <span className={styles.item} style={{ color: "var(--red)" }}>
        <WarningCircle size={12} />
        {label} · error
      </span>
    );
  }

  return (
    <span
      className={styles.item}
      style={{ color: status === "working" ? "var(--green)" : "var(--text-dim)" }}
    >
      <Sparkle size={12} className={status === "working" ? "mo-spin" : undefined} />
      {label} · {status}
    </span>
  );
}

// Branch/ahead-behind/changes reflect the real active worktree (Phase 2).
export function StatusBar() {
  const theme = useUiStore((s) => s.theme);
  const activeWorktree = useActiveWorktree();

  return (
    <div className={styles.bar}>
      {activeWorktree ? (
        <>
          <span className={styles.item} style={{ color: "var(--accent)" }}>
            <GitBranch size={13} />
            {activeWorktree.branch}
          </span>
          <span className={styles.item}>
            <ArrowsClockwise size={12} />
            {activeWorktree.ahead}↑ {activeWorktree.behind}↓
          </span>
          {activeWorktree.dirty && (
            <span className={styles.item} style={{ color: "var(--yellow)" }}>
              <CircleHalf size={12} />
              {activeWorktree.changedFiles} changes
            </span>
          )}
        </>
      ) : (
        <span className={styles.item}>No worktree selected</span>
      )}

      <div className={styles.spacer} />

      <ActiveTabStatus />
      <span>Theme: {THEME_LABELS[theme]}</span>
      <Bell size={13} />
    </div>
  );
}
