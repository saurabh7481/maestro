import { useMemo, useState } from "react";
import { Info, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useActiveWorktree } from "../../state/workspaceStore";
import {
  openProblem,
  problemsForWorktree,
  sortProblems,
  useProblemsStore,
} from "../../state/problemsStore";
import type { Problem, ProblemSeverity } from "../../types/problem";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./ProblemsPanel.module.css";

type SeverityFilter = "all" | "error" | "warning";

function SeverityIcon({ severity }: { severity: ProblemSeverity }) {
  if (severity === "error") return <XCircle size={14} weight="fill" />;
  if (severity === "warning") return <WarningCircle size={14} weight="fill" />;
  return <Info size={14} weight="fill" />;
}

export function ProblemsPanel() {
  const activeWorktree = useActiveWorktree();
  const byOwner = useProblemsStore((state) => state.byOwner);
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const problems = useMemo(() => {
    const scoped = problemsForWorktree(byOwner, activeWorktree?.id).filter((problem) =>
      filter === "all" ? true : problem.severity === filter,
    );
    return sortProblems(scoped);
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
                  onClick={() => activeWorktree && openProblem(activeWorktree, problem)}
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
