import { create } from "zustand";
import { gitApi } from "../api/git";
import { listenToScmEvents } from "../api/scmEvents";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  CommitFileEntry,
  CommitSummary,
  DiffContent,
  DiffMode,
  ScmEvent,
  WorkingStatus,
} from "../types/git";

const COMMIT_PAGE_SIZE = 50;

function diffCacheKey(mode: DiffMode, relPath: string, commitHash?: string): string {
  return `${mode}:${relPath}:${commitHash ?? ""}`;
}

interface ScmState {
  worktreeId: string | null;
  worktreeRoot: string | null;
  status: WorkingStatus | null;
  commits: CommitSummary[];
  commitsExhausted: boolean;
  diffCache: Map<string, DiffContent>;
  error: string | null;
  unlisten: (() => void) | null;

  openForWorktree: (worktreeId: string, worktreeRoot: string) => Promise<void>;
  closeWorktree: () => Promise<void>;
  applyScmEvent: (event: ScmEvent) => void;
  refreshStatus: () => Promise<void>;

  stagePaths: (relPaths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstagePaths: (relPaths: string[]) => Promise<void>;
  unstageAll: () => Promise<void>;
  discardChange: (relPath: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  fetch: () => Promise<void>;

  loadCommitLog: (reset?: boolean) => Promise<void>;
  getCommitFiles: (hash: string) => Promise<CommitFileEntry[]>;
  getDiff: (relPath: string, mode: DiffMode, commitHash?: string) => Promise<DiffContent>;
  clearError: () => void;
}

/** Worktree-scoped SCM state: working-tree status, commit history, and a
 * diff-content cache. Deliberately a separate store from `explorerStore`
 * (tree-shaped: `childrenByDir`/`expandedPaths`) rather than folded into
 * it — SCM state is flat and has no tree-expansion concern to share, and
 * the codebase's existing convention is one store per concern
 * (`openFilesStore`/`fileLoadStore` are already split out from
 * `explorerStore` the same way) wired together in `AppShell.tsx`. Does
 * *not* own the file watcher lifecycle — `explorerStore` already
 * starts/stops the one watcher per active worktree; this store only
 * listens to the `scm://` channel it emits onto. */
export const useScmStore = create<ScmState>((set, get) => ({
  worktreeId: null,
  worktreeRoot: null,
  status: null,
  commits: [],
  commitsExhausted: false,
  diffCache: new Map(),
  error: null,
  unlisten: null,

  openForWorktree: async (worktreeId, worktreeRoot) => {
    if (get().worktreeId === worktreeId) return;

    const prevUnlisten = get().unlisten;
    if (prevUnlisten) prevUnlisten();

    set({
      worktreeId,
      worktreeRoot,
      status: null,
      commits: [],
      commitsExhausted: false,
      diffCache: new Map(),
      error: null,
      unlisten: null,
    });

    const unlisten = await listenToScmEvents(worktreeId, (event) => {
      if (get().worktreeId === worktreeId) get().applyScmEvent(event);
    });
    set({ unlisten });

    await get().refreshStatus();
  },

  closeWorktree: async () => {
    const { unlisten } = get();
    if (unlisten) unlisten();
    set({
      worktreeId: null,
      worktreeRoot: null,
      status: null,
      commits: [],
      commitsExhausted: false,
      diffCache: new Map(),
      error: null,
      unlisten: null,
    });
  },

  // Invalidates the diff cache wholesale on every status change rather
  // than trying to patch individual entries — diffs are cheap to refetch,
  // and a currently-open diff tab re-fetching after a stage/unstage is
  // exactly the behavior that keeps it from showing stale content.
  applyScmEvent: (event) => {
    set({ status: event.status, diffCache: new Map() });
    const { worktreeId } = get();
    if (worktreeId) {
      useWorkspaceStore.getState().updateWorktreeStatus(worktreeId, {
        ahead: event.status.ahead,
        behind: event.status.behind,
        dirty: event.status.entries.length > 0,
        changedFiles: event.status.entries.length,
      });
    }
  },

  refreshStatus: async () => {
    const { worktreeRoot, worktreeId } = get();
    if (!worktreeRoot) return;
    try {
      const status = await gitApi.getWorkingStatus(worktreeRoot);
      if (get().worktreeId === worktreeId) {
        get().applyScmEvent({ type: "statusChanged", status });
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  stagePaths: async (relPaths) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.stagePaths(worktreeId, worktreeRoot, relPaths);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  stageAll: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.stageAll(worktreeId, worktreeRoot);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  unstagePaths: async (relPaths) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.unstagePaths(worktreeId, worktreeRoot, relPaths);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  unstageAll: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.unstageAll(worktreeId, worktreeRoot);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  discardChange: async (relPath) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.discardChange(worktreeId, worktreeRoot, relPath);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  commit: async (message) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.commitChanges(worktreeId, worktreeRoot, message);
      // History changed — dropped here and reloaded lazily the next time
      // HistoryView is open/mounted, rather than eagerly refetched now.
      set({ commits: [], commitsExhausted: false });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  push: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.pushChanges(worktreeId, worktreeRoot);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  pull: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.pullChanges(worktreeId, worktreeRoot);
      set({ commits: [], commitsExhausted: false });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  fetch: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.fetchRemote(worktreeId, worktreeRoot);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  loadCommitLog: async (reset = false) => {
    const { worktreeRoot, commits, commitsExhausted } = get();
    if (!worktreeRoot) return;
    if (!reset && commitsExhausted) return;
    const skip = reset ? 0 : commits.length;
    try {
      const page = await gitApi.getCommitLog(worktreeRoot, COMMIT_PAGE_SIZE, skip);
      set((s) => ({
        commits: reset ? page : [...s.commits, ...page],
        commitsExhausted: page.length < COMMIT_PAGE_SIZE,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  getCommitFiles: async (hash) => {
    const { worktreeRoot } = get();
    if (!worktreeRoot) return [];
    return gitApi.getCommitFiles(worktreeRoot, hash);
  },

  getDiff: async (relPath, mode, commitHash) => {
    const { worktreeRoot, diffCache } = get();
    if (!worktreeRoot) throw new Error("no active worktree");
    const key = diffCacheKey(mode, relPath, commitHash);
    const cached = diffCache.get(key);
    if (cached) return cached;
    const diff = await gitApi.getDiffContent(worktreeRoot, relPath, mode, commitHash);
    set((s) => ({ diffCache: new Map(s.diffCache).set(key, diff) }));
    return diff;
  },

  clearError: () => set({ error: null }),
}));
