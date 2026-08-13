import { ArrowsClockwise, Bell, CircleHalf, GitBranch, Sparkle } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { THEME_LABELS } from "../../design/themes";
import styles from "./StatusBar.module.css";

// Branch/ahead-behind/changes reflect the real active worktree (Phase 2).
// The agent status stays a placeholder until Phase 5 wires real sessions.
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

      <span className={styles.item} style={{ color: "var(--green)" }}>
        <Sparkle size={12} />
        Claude Code · working
      </span>
      <span>Theme: {THEME_LABELS[theme]}</span>
      <Bell size={13} />
    </div>
  );
}
