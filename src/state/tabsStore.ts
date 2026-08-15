import { create } from "zustand";
import type { DiffMode } from "../types/git";
import type { AgentKind } from "../types/agent";

export type TabType = "agent" | "file" | "markdown" | "diff" | "terminal";

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  /** File/markdown tabs only. `id` is derived as `${worktreeId}:${filePath}`
   * for these, so opening the same file twice reuses the tab via
   * `ensureTab`'s existing dedup-by-`id` logic. */
  filePath?: string;
  worktreeRoot?: string;
  /** Diff tabs only — which side of the working tree (or a specific
   * commit) this diff shows. Combined with `filePath`/`commitHash` in
   * `diffTabId()` so the same file can have distinct open tabs per mode. */
  diffMode?: DiffMode;
  /** Diff tabs in `commit` mode only. */
  commitHash?: string;
  /** Worktree id for process-backed/editor tabs. Agent tab `id` doubles
   * as the run id the Rust side keys
   * `AgentRunEntry`/events on (`agents/manager.rs`), and `worktreeId` is
   * what `kill_agent_runs_for_worktree` matches against on worktree
   * removal. */
  agentKind?: AgentKind;
  worktreeId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
}

export function fileTabId(worktreeId: string, relPath: string): string {
  return `${worktreeId}:${relPath}`;
}

/** A diff tab's id is derived, same dedup-by-`id` reasoning as
 * `fileTabId` — the same file can legitimately have separate open tabs
 * for its unstaged diff, its staged diff, and any number of past-commit
 * diffs, so `mode`/`commitHash` are part of the identity, not just
 * display state. */
export function diffTabId(
  worktreeId: string,
  relPath: string,
  mode: DiffMode,
  commitHash?: string,
): string {
  return mode === "commit"
    ? `diff:${worktreeId}:${commitHash}:${relPath}`
    : `diff:${worktreeId}:${mode}:${relPath}`;
}

/** Every worktree-scoped tab (all of them, in practice — file, markdown,
 * diff, terminal, and agent tabs all carry `worktreeRoot`) is bucketed
 * under its `worktreeRoot` here; tabs with no `worktreeRoot` share the
 * `""` bucket. Keyed by path rather than worktree id because that's the
 * one field every tab type already carries (agent tabs carry both
 * `worktreeId` and `worktreeRoot`; file/diff/terminal tabs only have the
 * latter) — see `worktreeKey` below. */
function worktreeKey(tab: Pick<Tab, "worktreeRoot">): string {
  return tab.worktreeRoot ?? "";
}

interface TabsState {
  /** Every open tab across every worktree — a worktree's agent/terminal
   * processes keep running when it's not the active one (docs/V1_SCOPE.md
   * §3: "switching worktrees swaps the tab strip; agent processes for
   * background worktrees keep running"), so this list is never filtered
   * down to just the active worktree. Only `activeTabId` and, by
   * extension, which tabs actually render in the strip (`TabStrip.tsx`)
   * are scoped to the active worktree. */
  tabs: Tab[];
  activeTabId: string | null;
  /** Remembers each worktree's own active tab so switching back to a
   * worktree restores where you left off, not just its first tab. */
  activeTabIdByWorktree: Record<string, string | null>;

  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  openTab: (tab: Tab) => void;
  ensureTab: (tab: Tab) => void;
  /** Called when the active worktree changes (see
   * `design/useWorktreeTabSync.ts`) — swaps `activeTabId` to whichever
   * tab was last active for `worktreeRoot`, or that worktree's first
   * tab, or `null` if it has none open yet. Never touches `tabs` itself:
   * background worktrees' tabs/processes are untouched, only what's
   * currently focused changes. */
  switchToWorktree: (worktreeRoot: string | null) => void;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  activeTabIdByWorktree: {},

  setActiveTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return { activeTabId: id };
      return {
        activeTabId: id,
        activeTabIdByWorktree: { ...s.activeTabIdByWorktree, [worktreeKey(tab)]: id },
      };
    }),

  closeTab: (id) =>
    set((s) => {
      const closed = s.tabs.find((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (s.activeTabId !== id || !closed) {
        return { tabs };
      }
      // The fallback after closing the active tab must come from the
      // *same* worktree — falling back to whatever's first in the global
      // list would silently jump the visible strip to a different
      // worktree's tabs.
      const key = worktreeKey(closed);
      const fallback = tabs.find((t) => worktreeKey(t) === key)?.id ?? null;
      return {
        tabs,
        activeTabId: fallback,
        activeTabIdByWorktree: { ...s.activeTabIdByWorktree, [key]: fallback },
      };
    }),

  openTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      activeTabIdByWorktree: { ...s.activeTabIdByWorktree, [worktreeKey(tab)]: tab.id },
    })),

  ensureTab: (tab) => {
    const exists = get().tabs.some((t) => t.id === tab.id);
    if (exists) {
      get().setActiveTab(tab.id);
    } else {
      get().openTab(tab);
    }
  },

  switchToWorktree: (worktreeRoot) =>
    set((s) => {
      const key = worktreeRoot ?? "";
      const scoped = s.tabs.filter((t) => worktreeKey(t) === key);
      const remembered = s.activeTabIdByWorktree[key];
      const activeTabId =
        remembered && scoped.some((t) => t.id === remembered)
          ? remembered
          : (scoped[0]?.id ?? null);
      return { activeTabId };
    }),
}));
