import { ArrowsClockwise, Bell, CircleHalf, GitBranch, Sparkle } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { THEME_LABELS } from "../../design/themes";
import styles from "./StatusBar.module.css";

// Placeholder git/agent status until Phase 2 (git) and Phase 5 (agents)
// wire real state.
export function StatusBar() {
  const theme = useUiStore((s) => s.theme);

  return (
    <div className={styles.bar}>
      <span className={styles.item} style={{ color: "var(--accent)" }}>
        <GitBranch size={13} />
        feat/payments-refactor
      </span>
      <span className={styles.item}>
        <ArrowsClockwise size={12} />
        2↑ 0↓
      </span>
      <span className={styles.item} style={{ color: "var(--yellow)" }}>
        <CircleHalf size={12} />4 changes
      </span>

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
