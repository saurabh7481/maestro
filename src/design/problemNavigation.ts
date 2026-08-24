import { useActiveWorktree } from "../state/workspaceStore";
import {
  openProblem,
  problemsForWorktree,
  sortProblems,
  useProblemsStore,
} from "../state/problemsStore";
import type { Worktree } from "../types/workspace";

/** The last problem jumped to, by id — not per-worktree, since switching
 * worktrees mid-cycle is rare enough that "start from the top again" is a
 * fine reset. Module state rather than a store: nothing else needs to
 * read or react to it, it only exists to answer "next relative to what". */
let lastProblemId: string | null = null;

function cycle(worktree: Worktree, direction: 1 | -1): void {
  const problems = sortProblems(
    problemsForWorktree(useProblemsStore.getState().byOwner, worktree.id),
  );
  if (problems.length === 0) return;
  const currentIndex = lastProblemId ? problems.findIndex((p) => p.id === lastProblemId) : -1;
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : problems.length - 1
      : (currentIndex + direction + problems.length) % problems.length;
  const next = problems[nextIndex];
  lastProblemId = next.id;
  openProblem(worktree, next);
}

export function goToNextProblem(worktree: Worktree): void {
  cycle(worktree, 1);
}

export function goToPreviousProblem(worktree: Worktree): void {
  cycle(worktree, -1);
}

/** Whether there's anything to cycle through right now — gates the
 * next/prev-problem keybindings and command palette entries alike. */
export function useHasProblems(): boolean {
  const activeWorktree = useActiveWorktree();
  const byOwner = useProblemsStore((s) => s.byOwner);
  return !!activeWorktree && problemsForWorktree(byOwner, activeWorktree.id).length > 0;
}
