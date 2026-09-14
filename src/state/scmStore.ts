import { create } from "zustand";
import { gitApi } from "../api/git";
import { listenToScmEvents } from "../api/scmEvents";
import { useWorkspaceStore } from "./workspaceStore";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";
import type {
  CommitFileEntry,
  CommitSummary,
  DiffContent,
  DiffMode,
  GitRemoteError,
  PullStrategy,
  RemoteOutcome,
  ScmEvent,
  WorkingStatus,
} from "../types/git";

const COMMIT_PAGE_SIZE = 50;

/** Which SCM operation is in flight. Held in the store rather than in
 * `CommitBox`'s local state so every entry point agrees: the buttons, the
 * command palette (`Git: Pull`), and a remedy clicked off an error card
 * all see the same one-operation-at-a-time guard. Two concurrent pulls
 * racing over `.git/index.lock` was its own class of "sometimes it just
 * doesn't work". */
export type ScmOperation = "commit" | "push" | "pull" | "fetch";

/** Everything that reaches the SCM error surface is normalized to a
 * `GitRemoteError`, whatever it was thrown as.
 *
 * `push_changes`/`pull_changes`/`fetch_remote` reject with a real
 * structured object (see `git_remote.rs`); every *local* command still
 * rejects with a bare string, and a bug in the renderer would throw an
 * `Error`. Wrapping the latter two keeps the error card's contract to one
 * shape instead of making it handle three. */
export function toRemoteError(value: unknown, fallbackTitle: string): GitRemoteError {
  if (
    value &&
    typeof value === "object" &&
    "code" in value &&
    "title" in value &&
    "detail" in value
  ) {
    return value as GitRemoteError;
  }
  const detail = value instanceof Error ? value.message : String(value);
  return {
    code: "unknown",
    title: fallbackTitle,
    // Git's one-line `fatal:`/`error:` messages read fine as the body;
    // anything longer stays in `detail` behind the disclosure.
    message: detail.split("\n")[0]?.trim() || "See the details below.",
    detail,
    paths: [],
    actions: [],
  };
}

/** Errors raised while the Source Control panel is on screen are already
 * reported there in full, so a toast would just say the same thing twice.
 * Anything triggered from the command palette with the panel closed has
 * no other surface, and does need one. */
function scmPanelVisible(): boolean {
  const ui = useUiStore.getState();
  return ui.rightSidebarOpen && ui.sidebarView === "scm";
}

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
  error: GitRemoteError | null;
  /** Non-null while an SCM operation is running; see `ScmOperation`. */
  busy: ScmOperation | null;
  unlisten: (() => void) | null;

  openForWorktree: (worktreeId: string, worktreeRoot: string) => Promise<void>;
  closeWorktree: () => Promise<void>;
  applyScmEvent: (event: ScmEvent) => void;
  refreshStatus: () => Promise<void>;

  stagePaths: (relPaths: string[]) => Promise<void>;
  stageHunk: (relPath: string, unstage: boolean, newStart: number, newEnd: number) => Promise<void>;
  stageAll: () => Promise<void>;
  unstagePaths: (relPaths: string[]) => Promise<void>;
  unstageAll: () => Promise<void>;
  discardChange: (relPath: string) => Promise<void>;
  discardPaths: (relPaths: string[]) => Promise<void>;
  commit: (message: string) => Promise<void>;
  push: (forceWithLease?: boolean) => Promise<void>;
  pull: (strategy?: PullStrategy) => Promise<void>;
  fetch: () => Promise<void>;
  /** Pull, then push — the remedy for a push rejected because the remote
   * moved on. Stops at the pull if that fails, leaving its error up. */
  pullThenPush: () => Promise<void>;
  /** Re-runs the last remote operation with the same options. Backs the
   * error card's "Try Again" so a retry can't silently become a
   * different operation than the one that failed. */
  retryLastRemote: () => Promise<void>;

  loadCommitLog: (reset?: boolean) => Promise<void>;
  getCommitFiles: (hash: string) => Promise<CommitFileEntry[]>;
  getDiff: (relPath: string, mode: DiffMode, commitHash?: string) => Promise<DiffContent>;
  clearError: () => void;
}

/** The last remote operation, with its options, so "Try Again" repeats
 * exactly what failed rather than guessing from the error. Module-level
 * rather than store state: it's a closure, never rendered, and putting a
 * function in the store would make every subscriber re-render whenever
 * the user pulls. */
let lastRemoteRun: (() => Promise<void>) | null = null;

/** The one place a remote operation's lifecycle lives: refuse to start if
 * something else is already running, clear the previous error so a stale
 * red card can't outlive the failure that produced it (it used to sit
 * there until clicked, including through a *successful* retry), report
 * the outcome, and always release the busy flag. */
async function runRemote(
  get: () => ScmState,
  set: (partial: Partial<ScmState>) => void,
  operation: ScmOperation,
  fallbackTitle: string,
  run: (worktreeId: string, worktreeRoot: string) => Promise<RemoteOutcome>,
  onSuccess?: () => void,
): Promise<void> {
  const { worktreeId, worktreeRoot, busy } = get();
  if (!worktreeId || !worktreeRoot || busy) return;
  set({ busy: operation, error: null });
  try {
    const outcome = await run(worktreeId, worktreeRoot);
    onSuccess?.();
    useToastStore.getState().push({ tone: "success", title: outcome.summary });
  } catch (error) {
    const remoteError = toRemoteError(error, fallbackTitle);
    set({ error: remoteError });
    if (!scmPanelVisible()) {
      useToastStore.getState().push({
        tone: "error",
        title: remoteError.title,
        description: remoteError.message,
      });
    }
    throw remoteError;
  } finally {
    set({ busy: null });
  }
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
  busy: null,
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
      busy: null,
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
      busy: null,
      unlisten: null,
    });
  },

  // Invalidates the diff cache wholesale on every status change rather
  // than trying to patch individual entries — diffs are cheap to refetch,
  // and a currently-open diff tab re-fetching after a stage/unstage is
  // exactly the behavior that keeps it from showing stale content.
  applyScmEvent: (event) => {
    // Defensive: a malformed event should be skipped, not crash the
    // whole renderer (see `api/fsEvents.ts`).
    if (!event?.status) return;
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
      set({ error: toRemoteError(error, "Could not read git status") });
    }
  },

  stagePaths: async (relPaths) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.stagePaths(worktreeId, worktreeRoot, relPaths);
    } catch (error) {
      set({ error: toRemoteError(error, "Stage failed") });
      throw error;
    }
  },

  stageHunk: async (relPath, unstage, newStart, newEnd) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.stageHunk(worktreeId, worktreeRoot, relPath, unstage, newStart, newEnd);
    } catch (error) {
      set({ error: toRemoteError(error, "Stage failed") });
      throw error;
    }
  },

  stageAll: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.stageAll(worktreeId, worktreeRoot);
    } catch (error) {
      set({ error: toRemoteError(error, "Stage failed") });
      throw error;
    }
  },

  unstagePaths: async (relPaths) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.unstagePaths(worktreeId, worktreeRoot, relPaths);
    } catch (error) {
      set({ error: toRemoteError(error, "Unstage failed") });
      throw error;
    }
  },

  unstageAll: async () => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.unstageAll(worktreeId, worktreeRoot);
    } catch (error) {
      set({ error: toRemoteError(error, "Unstage failed") });
      throw error;
    }
  },

  discardChange: async (relPath) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot) return;
    try {
      await gitApi.discardChange(worktreeId, worktreeRoot, relPath);
    } catch (error) {
      set({ error: toRemoteError(error, "Discard failed") });
      throw error;
    }
  },

  discardPaths: async (relPaths) => {
    const { worktreeId, worktreeRoot } = get();
    if (!worktreeId || !worktreeRoot || relPaths.length === 0) return;
    try {
      await gitApi.discardPaths(worktreeId, worktreeRoot, relPaths);
    } catch (error) {
      set({ error: toRemoteError(error, "Discard failed") });
      throw error;
    }
  },

  commit: async (message) => {
    const { worktreeId, worktreeRoot, busy } = get();
    if (!worktreeId || !worktreeRoot || busy) return;
    set({ busy: "commit", error: null });
    try {
      await gitApi.commitChanges(worktreeId, worktreeRoot, message);
      // History changed — dropped here and reloaded lazily the next time
      // HistoryView is open/mounted, rather than eagerly refetched now.
      set({ commits: [], commitsExhausted: false });
    } catch (error) {
      set({ error: toRemoteError(error, "Commit failed") });
      throw error;
    } finally {
      set({ busy: null });
    }
  },

  push: async (forceWithLease = false) => {
    lastRemoteRun = () => get().push(forceWithLease);
    await runRemote(get, set, "push", "Push failed", (id, root) =>
      gitApi.pushChanges(id, root, forceWithLease),
    );
  },

  pull: async (strategy = "fastForward") => {
    lastRemoteRun = () => get().pull(strategy);
    await runRemote(
      get,
      set,
      "pull",
      "Pull failed",
      (id, root) => gitApi.pullChanges(id, root, strategy),
      // Incoming commits invalidate the history page cache; HistoryView
      // reloads it lazily the next time it mounts.
      () => set({ commits: [], commitsExhausted: false }),
    );
  },

  fetch: async () => {
    lastRemoteRun = () => get().fetch();
    await runRemote(get, set, "fetch", "Fetch failed", (id, root) => gitApi.fetchRemote(id, root));
  },

  pullThenPush: async () => {
    try {
      await get().pull();
    } catch {
      // The pull's own error is already on screen and is the one the
      // user needs to act on — don't paper over it by pushing anyway.
      return;
    }
    await get().push();
  },

  retryLastRemote: async () => {
    // The failure it is retrying is already on screen; a new one replaces
    // it, so there is nothing to do with a rejection here.
    await lastRemoteRun?.().catch(() => {});
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
      set({ error: toRemoteError(error, "Could not load commit history") });
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
