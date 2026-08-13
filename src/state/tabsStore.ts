import { create } from "zustand";
import type { DiffMode } from "../types/git";

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

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  openTab: (tab: Tab) => void;
  ensureTab: (tab: Tab) => void;
}

// Placeholder content matching docs/design/Maestro IDE.dc.html, trimmed to
// only the tab types still awaiting their real implementation (agent:
// Phase 5, diff: Phase 4, terminal: Phase 7). "file"/"markdown" mock tabs
// were dropped in Phase 3 — those types now expect a real `filePath`/
// `worktreeRoot` (opened from the file tree), which fake placeholder tabs
// don't have.
const initialTabs: Tab[] = [
  { id: "a1", type: "agent", title: "Claude Code" },
  { id: "d1", type: "diff", title: "auth.controller.ts" },
  { id: "t1", type: "terminal", title: "zsh — payments" },
];

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: initialTabs,
  activeTabId: initialTabs[0].id,

  setActiveTab: (id) => set({ activeTabId: id }),

  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId = s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    }),

  openTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),

  ensureTab: (tab) => {
    const exists = get().tabs.some((t) => t.id === tab.id);
    if (exists) {
      set({ activeTabId: tab.id });
    } else {
      get().openTab(tab);
    }
  },
}));
