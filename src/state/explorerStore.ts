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

  openForWorktree: (worktreeId: string, worktreeRoot: string) => Promise<void>;
  closeWorktree: () => Promise<void>;
  toggleDir: (relPath: string) => void;
  createEntry: (parentRel: string, name: string, isDir: boolean) => Promise<void>;
  renameEntry: (fromRel: string, toRel: string) => Promise<void>;
  deleteEntry: (relPath: string) => Promise<void>;
  applyWatcherEvent: (event: FsChangeEvent) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => {
  async function loadDir(relPath: string) {
    const { worktreeRoot } = get();
    if (!worktreeRoot) return;
    set((s) => ({ loadingDirs: new Set(s.loadingDirs).add(relPath) }));
    try {
      const entries = await fsApi.listDir(worktreeRoot, relPath);
      set((s) => ({
        childrenByDir: new Map(s.childrenByDir).set(relPath, entries),
      }));
    } finally {
      set((s) => {
        const loadingDirs = new Set(s.loadingDirs);
        loadingDirs.delete(relPath);
        return { loadingDirs };
      });
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
      });

      const unlisten = await listenToFsEvents(worktreeId, (event) => {
        if (get().worktreeId === worktreeId) get().applyWatcherEvent(event);
      });
      set({ unlisten });

      await fsApi.startWorktreeWatcher(worktreeId, worktreeRoot);
      await loadDir("");
      try {
        const statusMap = await fsApi.getStatusMap(worktreeRoot);
        if (get().worktreeId === worktreeId) {
          set({ statusMap: statusMap as Record<string, GitGlyph> });
        }
      } catch {
        // Non-fatal — tree still renders without glyphs.
      }
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
      set({ statusMap: event.statusMap });
      const { childrenByDir } = get();
      for (const dir of event.changedDirs) {
        if (childrenByDir.has(dir)) void loadDir(dir);
      }
    },
  };
});
