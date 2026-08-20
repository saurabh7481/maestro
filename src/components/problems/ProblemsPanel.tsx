import { useMemo, useState } from "react";
import { Info, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useActiveWorktree } from "../../state/workspaceStore";
import { problemsForWorktree, useProblemsStore } from "../../state/problemsStore";
import { classifyFileTabType, fileTabId, useTabsStore } from "../../state/tabsStore";
import { useEditorNavigationStore } from "../../state/editorNavigationStore";
import type { Problem, ProblemSeverity } from "../../types/problem";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./ProblemsPanel.module.css";

type SeverityFilter = "all" | "error" | "warning";

const SEVERITY_RANK: Record<ProblemSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

function SeverityIcon({ severity }: { severity: ProblemSeverity }) {
  if (severity === "error") return <XCircle size={14} weight="fill" />;
  if (severity === "warning") return <WarningCircle size={14} weight="fill" />;
  return <Info size={14} weight="fill" />;
}

export function ProblemsPanel() {
  const activeWorktree = useActiveWorktree();
  const byOwner = useProblemsStore((state) => state.byOwner);
  const ensureTab = useTabsStore((state) => state.ensureTab);
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const problems = useMemo(() => {
    const scoped = problemsForWorktree(byOwner, activeWorktree?.id).filter((problem) =>
      filter === "all" ? true : problem.severity === filter,
    );
    return scoped.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.relativePath.localeCompare(b.relativePath) ||
        a.range.startLineNumber - b.range.startLineNumber ||
        a.range.startColumn - b.range.startColumn,
    );
  }, [activeWorktree?.id, byOwner, filter]);
  const groups = useMemo(() => {
    const grouped = new Map<string, Problem[]>();
    for (const problem of problems) {
      const existing = grouped.get(problem.relativePath);
      if (existing) existing.push(problem);
      else grouped.set(problem.relativePath, [problem]);
    }
    return [...grouped.entries()];
  }, [problems]);

  function openProblem(problem: Problem) {
    if (!activeWorktree || !problem.relativePath) return;
    const tabId = fileTabId(activeWorktree.id, problem.relativePath);
    ensureTab({
      id: tabId,
      type: classifyFileTabType(problem.relativePath),
      title: problem.relativePath.split("/").pop() ?? problem.relativePath,
      filePath: problem.relativePath,
      worktreeId: activeWorktree.id,
      worktreeRoot: activeWorktree.path,
    });
    useEditorNavigationStore.getState().request({ tabId, selection: problem.range });
  }

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>Problems · {problems.length}</span>
      </div>
      <div className={styles.filters} role="group" aria-label="Problem severity filter">
        {(["all", "error", "warning"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={styles.filter}
            data-active={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === "all" ? "All" : `${value[0]?.toUpperCase()}${value.slice(1)}s`}
          </button>
        ))}
      </div>
      {!activeWorktree ? (
        <div className={styles.empty}>No worktree selected.</div>
      ) : groups.length === 0 ? (
        <div className={styles.empty}>No problems in this worktree.</div>
      ) : (
        <div className={styles.body}>
          {groups.map(([path, entries]) => (
            <section key={path} className={styles.group}>
              <div className={styles.fileHeader} title={path}>
                <span>{path}</span>
                <span className={styles.count}>{entries.length}</span>
              </div>
              {entries.map((problem) => (
                <button
                  key={problem.id}
                  type="button"
                  className={styles.problem}
                  data-severity={problem.severity}
                  data-stale={problem.stale}
                  onClick={() => openProblem(problem)}
                  title={problem.message}
                >
                  <span className={styles.severity}>
                    <SeverityIcon severity={problem.severity} />
                  </span>
                  <span className={styles.problemText}>
                    <span className={styles.message}>{problem.message}</span>
                    <span className={styles.meta}>
                      {problem.sourceId}
                      {problem.code ? `(${problem.code})` : ""} · {problem.range.startLineNumber}:
                      {problem.range.startColumn}
                      {problem.stale ? " · stale" : ""}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
