import { create } from "zustand";
import type { Problem, ProblemSeverity, ProblemSourceKind, ProblemSummary } from "../types/problem";

const MAX_PROBLEMS_PER_OWNER = 10_000;
const SEVERITY_ORDER: ProblemSeverity[] = ["error", "warning", "info", "hint"];

export interface ProblemOwner {
  worktreeId: string;
  sourceKind: ProblemSourceKind;
  sourceId: string;
  ownerRunId?: string;
}

interface ReplaceDocumentProblems extends ProblemOwner {
  uri: string;
  problems: Problem[];
}

interface ProblemsState {
  byOwner: Record<string, Problem[]>;
  replaceDocumentProblems: (update: ReplaceDocumentProblems) => void;
  clearSource: (owner: ProblemOwner) => void;
  clearWorktree: (worktreeId: string) => void;
  markSourceStale: (owner: ProblemOwner) => void;
}

export function problemOwnerKey(owner: ProblemOwner): string {
  return [owner.sourceKind, owner.worktreeId, owner.sourceId, owner.ownerRunId ?? ""].join(
    "\u0000",
  );
}

function sameOwner(problem: Problem, owner: ProblemOwner) {
  return (
    problem.worktreeId === owner.worktreeId &&
    problem.sourceKind === owner.sourceKind &&
    problem.sourceId === owner.sourceId &&
    problem.ownerRunId === owner.ownerRunId
  );
}

export function problemsForWorktree(
  byOwner: Record<string, Problem[]>,
  worktreeId: string | null | undefined,
): Problem[] {
  if (!worktreeId) return [];
  return Object.values(byOwner)
    .flatMap((problems) => problems)
    .filter((problem) => problem.worktreeId === worktreeId);
}

export function summarizeProblems(problems: Problem[]): ProblemSummary {
  const summary: ProblemSummary = {
    total: problems.length,
    error: 0,
    warning: 0,
    info: 0,
    hint: 0,
    stale: 0,
  };
  for (const problem of problems) {
    summary[problem.severity] += 1;
    if (problem.stale) summary.stale += 1;
  }
  summary.highestSeverity = SEVERITY_ORDER.find((severity) => summary[severity] > 0);
  return summary;
}

/** Returns exact-file counts, or descendant counts for a directory. Path
 * comparisons use a slash boundary so `src/app` never absorbs `src/apple`. */
export function problemSummaryForPath(
  byOwner: Record<string, Problem[]>,
  worktreeId: string | null | undefined,
  relativePath: string,
  isDirectory = false,
): ProblemSummary {
  const prefix = relativePath ? `${relativePath.replace(/\/$/, "")}/` : "";
  const matching = problemsForWorktree(byOwner, worktreeId).filter((problem) =>
    isDirectory
      ? !relativePath || problem.relativePath.startsWith(prefix)
      : problem.relativePath === relativePath,
  );
  return summarizeProblems(matching);
}

/** Builds explorer badges in O(problem depth), rather than scanning every
 * problem once for every visible virtualized tree row. */
export function buildProblemPathSummaries(
  byOwner: Record<string, Problem[]>,
  worktreeId: string | null | undefined,
): Record<string, ProblemSummary> {
  const result: Record<string, ProblemSummary> = {};
  for (const problem of problemsForWorktree(byOwner, worktreeId)) {
    const segments = problem.relativePath.split("/").filter(Boolean);
    const paths = [problem.relativePath];
    for (let index = 1; index < segments.length; index += 1) {
      paths.push(segments.slice(0, index).join("/"));
    }
    for (const path of paths) {
      const summary = result[path] ?? {
        total: 0,
        error: 0,
        warning: 0,
        info: 0,
        hint: 0,
        stale: 0,
      };
      summary.total += 1;
      summary[problem.severity] += 1;
      if (problem.stale) summary.stale += 1;
      summary.highestSeverity = SEVERITY_ORDER.find((severity) => summary[severity] > 0);
      result[path] = summary;
    }
  }
  return result;
}

export const useProblemsStore = create<ProblemsState>((set) => ({
  byOwner: {},

  replaceDocumentProblems: (update) =>
    set((state) => {
      const key = problemOwnerKey(update);
      const previous = state.byOwner[key] ?? [];
      const retained = previous.filter((problem) => problem.uri !== update.uri);
      const ownedProblems = update.problems.map((problem) => ({
        ...problem,
        worktreeId: update.worktreeId,
        sourceKind: update.sourceKind,
        sourceId: update.sourceId,
        ownerRunId: update.ownerRunId,
        uri: update.uri,
      }));
      const next = [...retained, ...ownedProblems].slice(-MAX_PROBLEMS_PER_OWNER);
      if (next.length === 0 && !(key in state.byOwner)) return state;
      const byOwner = { ...state.byOwner };
      if (next.length === 0) delete byOwner[key];
      else byOwner[key] = next;
      return { byOwner };
    }),

  clearSource: (owner) =>
    set((state) => {
      const key = problemOwnerKey(owner);
      if (!(key in state.byOwner)) return state;
      const byOwner = { ...state.byOwner };
      delete byOwner[key];
      return { byOwner };
    }),

  clearWorktree: (worktreeId) =>
    set((state) => ({
      byOwner: Object.fromEntries(
        Object.entries(state.byOwner).filter(([, problems]) =>
          problems.every((problem) => problem.worktreeId !== worktreeId),
        ),
      ),
    })),

  markSourceStale: (owner) =>
    set((state) => {
      const key = problemOwnerKey(owner);
      const problems = state.byOwner[key];
      if (!problems || problems.every((problem) => problem.stale)) return state;
      return {
        byOwner: {
          ...state.byOwner,
          [key]: problems.map((problem) =>
            sameOwner(problem, owner) ? { ...problem, stale: true } : problem,
          ),
        },
      };
    }),
}));
