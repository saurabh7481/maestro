import {
  ArrowsClockwise,
  Bell,
  CircleHalf,
  Code,
  GitBranch,
  Info,
  Sparkle,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useTabsStore } from "../../state/tabsStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import { THEME_LABELS } from "../../design/themes";
import { useLspStore } from "../../state/lspStore";
import {
  problemsForWorktree,
  summarizeProblems,
  useProblemsStore,
} from "../../state/problemsStore";
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
  const lspRuntimes = useLspStore((state) => state.runtimeByKey);
  const problemsByOwner = useProblemsStore((state) => state.byOwner);
  const problemSummary = summarizeProblems(
    problemsForWorktree(problemsByOwner, activeWorktree?.id),
  );
  const activeLspStates = activeWorktree
    ? Object.entries(lspRuntimes)
        .filter(([key]) => key.startsWith(`${activeWorktree.id}:`))
        .map(([, runtime]) => runtime)
        .filter((runtime) => runtime.status !== "disabled")
    : [];
  const lspState = activeLspStates.some((runtime) => runtime.status === "error")
    ? "error"
    : activeLspStates.some((runtime) => runtime.status === "starting")
      ? "starting"
      : activeLspStates.length > 0
        ? "ready"
        : null;
  const lspDetail = activeLspStates.find((runtime) => runtime.status === "error")?.detail;

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
      {problemSummary.total > 0 && (
        <span className={styles.item} title={`${problemSummary.total} total problems`}>
          <XCircle size={12} color="var(--red)" /> {problemSummary.error}
          <WarningCircle size={12} color="var(--yellow)" /> {problemSummary.warning}
          <Info size={12} color="var(--accent-2)" /> {problemSummary.info + problemSummary.hint}
        </span>
      )}
      {lspState && (
        <span
          className={styles.item}
          title={lspDetail}
          style={{
            color:
              lspState === "error"
                ? "var(--red)"
                : lspState === "ready"
                  ? "var(--green)"
                  : "var(--yellow)",
          }}
        >
          <Code size={12} /> LSP · {lspState}
        </span>
      )}
      <span>Theme: {THEME_LABELS[theme]}</span>
      <Bell size={13} />
    </div>
  );
}
