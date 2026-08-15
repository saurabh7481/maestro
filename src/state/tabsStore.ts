import { create } from "zustand";
import type { DiffMode } from "../types/git";
import type { AgentKind } from "../types/agent";
import {
  collectPaneIds,
  edgeToSplit,
  insertBeside,
  leaf,
  pruneLayout,
  removePane,
  updateSizes,
  type LayoutNode,
  type SplitEdge,
} from "./paneLayout";

export type TabType = "agent" | "file" | "markdown" | "diff" | "terminal" | "processes";

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

/** One editor pane: a tab strip and the content area under it. Tab
 * *order* lives here rather than in the `tabs` array, because reordering
 * and moving tabs between panes is exactly what the drag interaction
 * does, and one owner of order means a drag can't leave the two
 * disagreeing (`chrome/useTabDrag.ts`). */
export interface Pane {
  id: string;
  /** Which worktree bucket this pane belongs to — `worktreeRoot ?? ""`,
   * the same key `worktreeKey` derives from a tab. Panes are per-worktree
   * for the same reason tabs are (docs/V1_SCOPE.md §3): switching
   * worktrees swaps the whole editor area, it doesn't mix two worktrees'
   * files into one split. */
  worktreeKey: string;
  tabIds: string[];
  activeTabId: string | null;
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

/** The Process Manager is one tab per worktree bucket, not one per click —
 * it shows every process across every project regardless of which
 * worktree's strip it lives in, so opening it twice from the same
 * worktree should reuse the tab. */
export function processesTabId(worktreeRoot: string | undefined): string {
  return `processes:${worktreeRoot ?? ""}`;
}

/** Every worktree-scoped tab (all of them, in practice — file, markdown,
 * diff, terminal, and agent tabs all carry `worktreeRoot`) is bucketed
 * under its `worktreeRoot` here; tabs with no `worktreeRoot` share the
 * `""` bucket. Keyed by path rather than worktree id because that's the
 * one field every tab type already carries (agent tabs carry both
 * `worktreeId` and `worktreeRoot`; file/diff/terminal tabs only have the
 * latter) — see `worktreeKey` below. */
export function worktreeKey(tab: Pick<Tab, "worktreeRoot">): string {
  return tab.worktreeRoot ?? "";
}

let idCounter = 0;
/** `crypto.randomUUID` isn't guaranteed in every test environment, and a
 * pane id only has to be unique within one window's lifetime. */
function newId(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(idCounter += 1)}`;
  return `${prefix}:${uuid}`;
}

/** The mutable half of the store — every helper below is a pure
 * `Snapshot -> Snapshot` function so the multi-step operations (move a
 * tab, which can empty a pane, which can collapse a split, which can
 * change what's focused) compose without half-applied intermediate state
 * ever reaching React. */
interface Snapshot {
  tabs: Tab[];
  panes: Record<string, Pane>;
  layouts: Record<string, LayoutNode>;
  activePaneByWorktree: Record<string, string>;
  activeTabId: string | null;
  activeTabIdByWorktree: Record<string, string | null>;
}

function paneOf(snapshot: Snapshot, tabId: string): Pane | undefined {
  return Object.values(snapshot.panes).find((pane) => pane.tabIds.includes(tabId));
}

/** Guarantees a worktree bucket has at least one pane, returning the id
 * of the one new tabs should open into. */
function ensurePane(snapshot: Snapshot, key: string): [Snapshot, string] {
  const activeId = snapshot.activePaneByWorktree[key];
  if (activeId && snapshot.panes[activeId]) return [snapshot, activeId];

  const existing = Object.values(snapshot.panes).find((pane) => pane.worktreeKey === key);
  if (existing) {
    return [
      {
        ...snapshot,
        activePaneByWorktree: { ...snapshot.activePaneByWorktree, [key]: existing.id },
      },
      existing.id,
    ];
  }

  const paneId = newId("pane");
  return [
    {
      ...snapshot,
      panes: {
        ...snapshot.panes,
        [paneId]: { id: paneId, worktreeKey: key, tabIds: [], activeTabId: null },
      },
      layouts: { ...snapshot.layouts, [key]: leaf(paneId) },
      activePaneByWorktree: { ...snapshot.activePaneByWorktree, [key]: paneId },
    },
    paneId,
  ];
}

/** Focuses a tab: its pane becomes the worktree's active pane, and it
 * becomes that pane's active tab. Passing `null` clears the pane's
 * selection (an emptied pane). */
function focusTab(snapshot: Snapshot, paneId: string, tabId: string | null): Snapshot {
  const pane = snapshot.panes[paneId];
  if (!pane) return snapshot;
  return {
    ...snapshot,
    panes: { ...snapshot.panes, [paneId]: { ...pane, activeTabId: tabId } },
    activePaneByWorktree: { ...snapshot.activePaneByWorktree, [pane.worktreeKey]: paneId },
    activeTabId: tabId,
    activeTabIdByWorktree: { ...snapshot.activeTabIdByWorktree, [pane.worktreeKey]: tabId },
  };
}

/** Removes a tab id from whichever pane holds it, promoting a neighbour
 * to active if the removed tab was the active one. Does not touch
 * `tabs` — callers decide whether the tab is closing or moving. */
function unlinkTab(snapshot: Snapshot, tabId: string): Snapshot {
  const pane = paneOf(snapshot, tabId);
  if (!pane) return snapshot;

  const index = pane.tabIds.indexOf(tabId);
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  const activeTabId =
    pane.activeTabId === tabId
      ? (tabIds[Math.min(index, tabIds.length - 1)] ?? null)
      : pane.activeTabId;
  const next: Snapshot = {
    ...snapshot,
    panes: { ...snapshot.panes, [pane.id]: { ...pane, tabIds, activeTabId } },
  };

  // Keep the worktree's remembered active tab honest when the tab that
  // just left was the one it pointed at.
  if (next.activeTabIdByWorktree[pane.worktreeKey] === tabId) {
    next.activeTabIdByWorktree = { ...next.activeTabIdByWorktree, [pane.worktreeKey]: activeTabId };
  }
  if (next.activeTabId === tabId) next.activeTabId = activeTabId;
  return next;
}

/** Drops a pane once it's empty — unless it's the last pane in its
 * worktree, which stays as the empty editor area the "no tabs open"
 * placeholder renders into. */
function collapseIfEmpty(snapshot: Snapshot, paneId: string): Snapshot {
  const pane = snapshot.panes[paneId];
  if (!pane || pane.tabIds.length > 0) return snapshot;

  const key = pane.worktreeKey;
  const layout = snapshot.layouts[key];
  if (!layout || collectPaneIds(layout).length <= 1) return snapshot;

  const nextLayout = removePane(layout, paneId);
  const panes = { ...snapshot.panes };
  delete panes[paneId];

  const survivors = nextLayout ? collectPaneIds(nextLayout) : [];
  const nextActivePane = survivors[0] ?? undefined;
  const activePaneByWorktree = { ...snapshot.activePaneByWorktree };
  if (activePaneByWorktree[key] === paneId) {
    if (nextActivePane) activePaneByWorktree[key] = nextActivePane;
    else delete activePaneByWorktree[key];
  }

  const layouts = { ...snapshot.layouts };
  if (nextLayout) layouts[key] = nextLayout;
  else delete layouts[key];

  let next: Snapshot = { ...snapshot, panes, layouts, activePaneByWorktree };
  // Focus follows the collapse: the pane that absorbed the space becomes
  // the focused one, so the very next tab opened doesn't land in a pane
  // the user can no longer see.
  if (snapshot.activePaneByWorktree[key] === paneId && nextActivePane) {
    next = focusTab(next, nextActivePane, next.panes[nextActivePane]?.activeTabId ?? null);
  }
  return next;
}

/** Inserts an already-existing tab id into a pane at `index` (appended
 * when omitted) and focuses it. */
function linkTab(snapshot: Snapshot, tabId: string, paneId: string, index?: number): Snapshot {
  const pane = snapshot.panes[paneId];
  if (!pane) return snapshot;
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  const at = index == null ? tabIds.length : Math.max(0, Math.min(index, tabIds.length));
  tabIds.splice(at, 0, tabId);
  return focusTab(
    { ...snapshot, panes: { ...snapshot.panes, [paneId]: { ...pane, tabIds } } },
    paneId,
    tabId,
  );
}

interface TabsState extends Snapshot {
  /** Every open tab across every worktree — a worktree's agent/terminal
   * processes keep running when it's not the active one (docs/V1_SCOPE.md
   * §3: "switching worktrees swaps the tab strip; agent processes for
   * background worktrees keep running"), so this list is never filtered
   * down to just the active worktree. Which tabs actually render is
   * decided by the panes of the active worktree's layout. */
  tabs: Tab[];

  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  openTab: (tab: Tab) => void;
  openTabInPane: (tab: Tab, paneId: string, index?: number) => void;
  ensureTab: (tab: Tab) => void;
  /** Called when the active worktree changes (see
   * `design/useWorktreeTabSync.ts`) — swaps `activeTabId` to whichever
   * tab was last active for `worktreeRoot`. Never touches `tabs` itself:
   * background worktrees' tabs/processes are untouched, only what's
   * currently focused changes. */
  switchToWorktree: (worktreeRoot: string | null) => void;

  /** Layout operations (docs/V2_ROADMAP.md Phase 13). */
  /** Guarantees the worktree has a pane to render, so a worktree with no
   * tabs open still shows a tab strip (and its `+` button) rather than a
   * dead empty area with no way to open anything. */
  ensurePaneForWorktree: (worktreeRoot: string | undefined) => void;
  focusPane: (paneId: string) => void;
  /** Splits `paneId` and moves `tabId` into the new pane. With no
   * `tabId`, the pane's active tab moves — matching what "split this
   * editor" means everywhere else. Returns the new pane's id. */
  splitPane: (paneId: string, edge: SplitEdge, tabId?: string) => string | null;
  /** Reorders within a pane, or moves across panes, in one operation —
   * the drag interaction never needs a remove-then-add pair that could
   * leave a tab in neither pane. */
  moveTab: (tabId: string, toPaneId: string, toIndex: number) => void;
  setPaneSizes: (worktreeKey: string, splitId: string, sizes: number[]) => void;
  /** Hands tabs to another window: forgets them here without touching
   * the backend processes behind them, which keep running and keep
   * emitting on the same channels the new window will listen to
   * (`chrome/satelliteWindows.ts`). */
  releaseTabs: (tabIds: string[]) => void;
  /** The receiving half of `releaseTabs` — takes tabs handed over by
   * another window, all into one pane. */
  adoptTabs: (tabs: Tab[], paneId?: string) => void;
  /** Replaces the whole layout — session restore and satellite handover
   * only. Prunes panes/layouts against the tabs actually being restored. */
  hydrate: (snapshot: Partial<Snapshot>) => void;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  panes: {},
  layouts: {},
  activePaneByWorktree: {},
  activeTabId: null,
  activeTabIdByWorktree: {},

  setActiveTab: (id) =>
    set((s) => {
      const pane = paneOf(s, id);
      if (!pane) return { activeTabId: id };
      return focusTab(s, pane.id, id);
    }),

  closeTab: (id) =>
    set((s) => {
      const pane = paneOf(s, id);
      const withoutTab: Snapshot = { ...s, tabs: s.tabs.filter((t) => t.id !== id) };
      const unlinked = unlinkTab(withoutTab, id);
      return pane ? collapseIfEmpty(unlinked, pane.id) : unlinked;
    }),

  openTab: (tab) =>
    set((s) => {
      const [withPane, paneId] = ensurePane(s, worktreeKey(tab));
      const withTab: Snapshot = { ...withPane, tabs: [...withPane.tabs, tab] };
      return linkTab(withTab, tab.id, paneId);
    }),

  openTabInPane: (tab, paneId, index) =>
    set((s) => {
      const exists = s.tabs.some((t) => t.id === tab.id);
      const withTab: Snapshot = exists ? s : { ...s, tabs: [...s.tabs, tab] };
      const unlinked = exists ? unlinkTab(withTab, tab.id) : withTab;
      const previousPane = exists ? paneOf(s, tab.id) : undefined;
      const linked = linkTab(unlinked, tab.id, paneId, index);
      return previousPane && previousPane.id !== paneId
        ? collapseIfEmpty(linked, previousPane.id)
        : linked;
    }),

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
      const activePaneId = s.activePaneByWorktree[key];
      const pane = activePaneId ? s.panes[activePaneId] : undefined;
      const fallbackPane = pane ?? Object.values(s.panes).find((p) => p.worktreeKey === key);
      const remembered = s.activeTabIdByWorktree[key];
      const activeTabId =
        remembered && fallbackPane?.tabIds.includes(remembered)
          ? remembered
          : (fallbackPane?.activeTabId ?? fallbackPane?.tabIds[0] ?? null);
      if (!fallbackPane) return { activeTabId: null };
      return {
        activeTabId,
        activePaneByWorktree: { ...s.activePaneByWorktree, [key]: fallbackPane.id },
        panes: { ...s.panes, [fallbackPane.id]: { ...fallbackPane, activeTabId } },
      };
    }),

  ensurePaneForWorktree: (worktreeRoot) =>
    set((s) => {
      const key = worktreeRoot ?? "";
      if (s.layouts[key]) return s;
      const [next] = ensurePane(s, key);
      return next;
    }),

  focusPane: (paneId) =>
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      return focusTab(s, paneId, pane.activeTabId);
    }),

  splitPane: (paneId, edge, tabId) => {
    const state = get();
    const source = state.panes[paneId];
    const movingTabId = tabId ?? source?.activeTabId ?? null;
    if (!source || !movingTabId) return null;
    // A pane with one tab splitting itself would just move that tab into
    // the new pane and leave an empty one behind, which collapses right
    // back — nothing to do.
    if (source.tabIds.length <= 1 && source.tabIds[0] === movingTabId) return null;

    const newPaneId = newId("pane");
    set((s) => {
      const pane = s.panes[paneId];
      const layout = s.layouts[pane.worktreeKey];
      if (!pane || !layout) return s;
      const { direction, before } = edgeToSplit(edge);
      const withPane: Snapshot = {
        ...s,
        panes: {
          ...s.panes,
          [newPaneId]: {
            id: newPaneId,
            worktreeKey: pane.worktreeKey,
            tabIds: [],
            activeTabId: null,
          },
        },
        layouts: {
          ...s.layouts,
          [pane.worktreeKey]: insertBeside(
            layout,
            paneId,
            newPaneId,
            direction,
            before,
            newId("split"),
          ),
        },
      };
      // The tab being moved in can come from a different pane entirely
      // (dragging a tab onto another pane's edge), so both the pane that
      // lost it and the pane that was split get a chance to collapse.
      const origin = paneOf(s, movingTabId);
      const unlinked = unlinkTab(withPane, movingTabId);
      const linked = linkTab(unlinked, movingTabId, newPaneId);
      const collapsed = collapseIfEmpty(linked, paneId);
      return origin && origin.id !== paneId ? collapseIfEmpty(collapsed, origin.id) : collapsed;
    });
    return newPaneId;
  },

  moveTab: (tabId, toPaneId, toIndex) =>
    set((s) => {
      const from = paneOf(s, tabId);
      if (!s.panes[toPaneId]) return s;
      // Reordering inside one pane must not renumber against a list the
      // tab has already been removed from — take the target index as the
      // caller measured it, against the pane as the user sees it.
      const samePane = from?.id === toPaneId;
      const currentIndex = from?.tabIds.indexOf(tabId) ?? -1;
      const adjusted =
        samePane && currentIndex !== -1 && currentIndex < toIndex ? toIndex - 1 : toIndex;
      const unlinked = unlinkTab(s, tabId);
      const linked = linkTab(unlinked, tabId, toPaneId, adjusted);
      return from && from.id !== toPaneId ? collapseIfEmpty(linked, from.id) : linked;
    }),

  setPaneSizes: (key, splitId, sizes) =>
    set((s) => {
      const layout = s.layouts[key];
      if (!layout) return s;
      return { layouts: { ...s.layouts, [key]: updateSizes(layout, splitId, sizes) } };
    }),

  releaseTabs: (tabIds) =>
    set((s) => {
      const releasing = new Set(tabIds);
      const touchedPaneIds = new Set(
        tabIds.map((id) => paneOf(s, id)?.id).filter((id): id is string => !!id),
      );
      let next: Snapshot = { ...s, tabs: s.tabs.filter((t) => !releasing.has(t.id)) };
      for (const tabId of tabIds) next = unlinkTab(next, tabId);
      for (const paneId of touchedPaneIds) next = collapseIfEmpty(next, paneId);
      return next;
    }),

  adoptTabs: (tabs, paneId) =>
    set((s) => {
      if (tabs.length === 0) return s;
      let next: Snapshot = s;
      let target = paneId && s.panes[paneId] ? paneId : undefined;
      if (!target) {
        const [withPane, ensured] = ensurePane(next, worktreeKey(tabs[0]));
        next = withPane;
        target = ensured;
      }
      const known = new Set(next.tabs.map((t) => t.id));
      next = { ...next, tabs: [...next.tabs, ...tabs.filter((tab) => !known.has(tab.id))] };
      for (const tab of tabs) next = linkTab(next, tab.id, target);
      return next;
    }),

  hydrate: (snapshot) =>
    set((s) => {
      const tabs = snapshot.tabs ?? s.tabs;
      const tabIds = new Set(tabs.map((t) => t.id));
      // A restored layout is only as trustworthy as the tabs that
      // survived restore (a worktree can disappear between sessions), so
      // every pane is filtered down to tabs that actually exist and every
      // layout down to panes that still hold something.
      const panes: Record<string, Pane> = {};
      for (const pane of Object.values(snapshot.panes ?? {})) {
        const paneTabIds = pane.tabIds.filter((id) => tabIds.has(id));
        panes[pane.id] = {
          ...pane,
          tabIds: paneTabIds,
          activeTabId:
            pane.activeTabId && paneTabIds.includes(pane.activeTabId)
              ? pane.activeTabId
              : (paneTabIds[0] ?? null),
        };
      }

      const layouts: Record<string, LayoutNode> = {};
      const keptPaneIds = new Set<string>();
      for (const [key, layout] of Object.entries(snapshot.layouts ?? {})) {
        // Empty panes are dropped on restore rather than preserved — a
        // split whose contents are all gone is noise, not layout.
        const nonEmpty = new Set(
          Object.values(panes)
            .filter((pane) => pane.worktreeKey === key && pane.tabIds.length > 0)
            .map((pane) => pane.id),
        );
        const pruned = pruneLayout(layout, nonEmpty);
        if (!pruned) continue;
        layouts[key] = pruned;
        for (const paneId of collectPaneIds(pruned)) keptPaneIds.add(paneId);
      }

      const survivingPanes: Record<string, Pane> = {};
      for (const paneId of keptPaneIds) {
        if (panes[paneId]) survivingPanes[paneId] = panes[paneId];
      }

      const activePaneByWorktree: Record<string, string> = {};
      for (const [key, paneId] of Object.entries(snapshot.activePaneByWorktree ?? {})) {
        if (survivingPanes[paneId]) activePaneByWorktree[key] = paneId;
      }
      for (const [key, layout] of Object.entries(layouts)) {
        if (!activePaneByWorktree[key]) activePaneByWorktree[key] = collectPaneIds(layout)[0];
      }

      // Tabs whose pane didn't survive would otherwise be invisible but
      // still open (and still holding a process) — they get folded into
      // their worktree's remaining pane instead of being silently lost.
      let next: Snapshot = {
        tabs,
        panes: survivingPanes,
        layouts,
        activePaneByWorktree,
        activeTabId: snapshot.activeTabId ?? null,
        activeTabIdByWorktree: snapshot.activeTabIdByWorktree ?? {},
      };
      const placed = new Set(Object.values(survivingPanes).flatMap((pane) => pane.tabIds));
      for (const tab of tabs) {
        if (placed.has(tab.id)) continue;
        const [withPane, paneId] = ensurePane(next, worktreeKey(tab));
        next = linkTab(withPane, tab.id, paneId);
      }
      return next;
    }),
}));

/** The panes of one worktree, in layout order. */
export function panesForWorktree(state: Snapshot, worktreeRoot: string | undefined): Pane[] {
  const key = worktreeRoot ?? "";
  const layout = state.layouts[key];
  if (!layout) return [];
  return collectPaneIds(layout)
    .map((paneId) => state.panes[paneId])
    .filter((pane): pane is Pane => !!pane);
}

/** The tabs of one pane, in strip order. */
export function tabsInPane(state: Snapshot, paneId: string): Tab[] {
  const pane = state.panes[paneId];
  if (!pane) return [];
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  return pane.tabIds.map((id) => byId.get(id)).filter((tab): tab is Tab => !!tab);
}
