import { create } from "zustand";
import { fsApi } from "../api/fs";
import { listenToFsEvents } from "../api/fsEvents";
import type { FsChangeEvent, FsEntry, GitGlyph } from "../types/fs";

function parentOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

interface ExplorerState {
  worktreeId: string | null;
  worktreeRoot: string | null;
  childrenByDir: Map<string, FsEntry[]>;
  expandedPaths: Set<string>;
  statusMap: Record<string, GitGlyph>;
  loadingDirs: Set<string>;
  unlisten: (() => void) | null;
  /** Set by `revealPath` once every ancestor directory of a path is
   * expanded and loaded — `FileTree.tsx` watches this to scroll the row
   * into view, then clears it. Not itself a "selection" concept; the
   * tree's existing `active` highlighting (keyed off the active tab)
   * still drives which row reads as selected. */
  pendingScrollPath: string | null;

  openForWorktree: (worktreeId: string, worktreeRoot: string) => Promise<void>;
  closeWorktree: () => Promise<void>;
  toggleDir: (relPath: string) => void;
  createEntry: (parentRel: string, name: string, isDir: boolean) => Promise<void>;
  renameEntry: (fromRel: string, toRel: string) => Promise<void>;
  deleteEntry: (relPath: string) => Promise<void>;
  applyWatcherEvent: (event: FsChangeEvent) => void;
  /** Expands (and loads) every ancestor directory of `relPath`, then sets
   * `pendingScrollPath` so the tree scrolls to it — the "Reveal in
   * Sidebar" action from a tab's context menu / the editor breadcrumb. */
  revealPath: (relPath: string) => Promise<void>;
  clearPendingScrollPath: () => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => {
  async function loadDir(relPath: string) {
    const { worktreeRoot, worktreeId, loadingDirs } = get();
    if (!worktreeRoot || !worktreeId || loadingDirs.has(relPath)) return;
    set((s) => ({ loadingDirs: new Set(s.loadingDirs).add(relPath) }));
    try {
      const entries = await fsApi.listDir(worktreeRoot, relPath);
      if (get().worktreeId !== worktreeId || get().worktreeRoot !== worktreeRoot) return;
      set((s) => ({
        childrenByDir: new Map(s.childrenByDir).set(relPath, entries),
      }));
      void fsApi.watchWorktreeDirectory(worktreeId, relPath).catch(() => {
        // Watcher startup is intentionally decoupled from tree rendering;
        // expanding a folder remains useful even if watching is unavailable.
      });
    } catch {
      // A directory can disappear or become unreadable between click and
      // enumeration. Keep the explorer responsive; the watcher/next expand
      // can retry it rather than leaking an unhandled rejection.
    } finally {
      if (get().worktreeId === worktreeId) {
        set((s) => {
          const loadingDirs = new Set(s.loadingDirs);
          loadingDirs.delete(relPath);
          return { loadingDirs };
        });
      }
    }
  }

  return {
    worktreeId: null,
    worktreeRoot: null,
    childrenByDir: new Map(),
    expandedPaths: new Set(),
    statusMap: {},
    loadingDirs: new Set(),
    unlisten: null,
    pendingScrollPath: null,

    openForWorktree: async (worktreeId, worktreeRoot) => {
      if (get().worktreeId === worktreeId) return;

      const prevUnlisten = get().unlisten;
      const prevWorktreeId = get().worktreeId;
      if (prevUnlisten) prevUnlisten();
      if (prevWorktreeId) void fsApi.stopWorktreeWatcher(prevWorktreeId);

      set({
        worktreeId,
        worktreeRoot,
        childrenByDir: new Map(),
        expandedPaths: new Set(),
        statusMap: {},
        loadingDirs: new Set(),
        unlisten: null,
        pendingScrollPath: null,
      });

      const unlisten = await listenToFsEvents(worktreeId, (event) => {
        if (get().worktreeId === worktreeId) get().applyWatcherEvent(event);
      });
      set({ unlisten });

      // Rendering the root directory must not wait for recursive watcher
      // registration or git status on a large monorepo.
      void fsApi
        .startWorktreeWatcher(worktreeId, worktreeRoot)
        .then(() => {
          if (get().worktreeId !== worktreeId) return;
          for (const directory of get().childrenByDir.keys()) {
            void fsApi.watchWorktreeDirectory(worktreeId, directory).catch(() => {});
          }
        })
        .catch(() => {});
      await loadDir("");
      void fsApi
        .getStatusMap(worktreeRoot)
        .then((statusMap) => {
          if (get().worktreeId === worktreeId) {
            set({ statusMap: statusMap as Record<string, GitGlyph> });
          }
        })
        .catch(() => {
          // Non-fatal — tree still renders without glyphs.
        });
    },

    closeWorktree: async () => {
      const { unlisten, worktreeId } = get();
      if (unlisten) unlisten();
      if (worktreeId) await fsApi.stopWorktreeWatcher(worktreeId);
      set({
        worktreeId: null,
        worktreeRoot: null,
        childrenByDir: new Map(),
        expandedPaths: new Set(),
        statusMap: {},
        loadingDirs: new Set(),
        unlisten: null,
        pendingScrollPath: null,
      });
    },

    toggleDir: (relPath) => {
      const expanded = get().expandedPaths.has(relPath);
      const expandedPaths = new Set(get().expandedPaths);
      if (expanded) {
        expandedPaths.delete(relPath);
        set({ expandedPaths });
      } else {
        expandedPaths.add(relPath);
        set({ expandedPaths });
        if (!get().childrenByDir.has(relPath)) void loadDir(relPath);
      }
    },

    revealPath: async (relPath) => {
      const { worktreeRoot, worktreeId } = get();
      if (!worktreeRoot || !worktreeId) return;

      const segments = relPath.split("/");
      segments.pop(); // the leaf itself never needs "expanding"
      const expandedPaths = new Set(get().expandedPaths);
      let ancestor = "";
      for (const segment of segments) {
        ancestor = ancestor ? `${ancestor}/${segment}` : segment;
        expandedPaths.add(ancestor);
        if (!get().childrenByDir.has(ancestor)) await loadDir(ancestor);
        // A worktree switch (or the whole panel closing) mid-walk means
        // this reveal no longer targets anything real — abandon it rather
        // than resurrecting stale expansion state for a torn-down tree.
        if (get().worktreeId !== worktreeId) return;
      }
      set({ expandedPaths, pendingScrollPath: relPath });
    },

    clearPendingScrollPath: () => set({ pendingScrollPath: null }),

    createEntry: async (parentRel, name, isDir) => {
      const { worktreeRoot } = get();
      if (!worktreeRoot) return;
      const relPath = parentRel ? `${parentRel}/${name}` : name;
      await fsApi.createEntry(worktreeRoot, relPath, isDir);
      const expandedPaths = new Set(get().expandedPaths);
      expandedPaths.add(parentRel);
      set({ expandedPaths });
      await loadDir(parentRel);
    },

    renameEntry: async (fromRel, toRel) => {
      const { worktreeRoot } = get();
      if (!worktreeRoot) return;
      await fsApi.renameEntry(worktreeRoot, fromRel, toRel);
      await loadDir(parentOf(fromRel));
      if (parentOf(toRel) !== parentOf(fromRel)) await loadDir(parentOf(toRel));
    },

    deleteEntry: async (relPath) => {
      const { worktreeRoot } = get();
      if (!worktreeRoot) return;
      await fsApi.deleteEntry(worktreeRoot, relPath);
      set((s) => {
        const childrenByDir = new Map(s.childrenByDir);
        childrenByDir.delete(relPath);
        const expandedPaths = new Set(s.expandedPaths);
        expandedPaths.delete(relPath);
        return { childrenByDir, expandedPaths };
      });
      await loadDir(parentOf(relPath));
    },

    applyWatcherEvent: (event: FsChangeEvent) => {
      // Belt-and-suspenders on top of `fsEvents.ts`'s own guard — never
      // let a malformed watcher event crash the whole renderer.
      if (!event?.changedDirs || !event.statusMap) return;
      set({ statusMap: event.statusMap });
      const { childrenByDir } = get();
      for (const dir of event.changedDirs) {
        if (childrenByDir.has(dir)) void loadDir(dir);
      }
    },
  };
});
