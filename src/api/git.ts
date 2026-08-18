import { invoke } from "@tauri-apps/api/core";
import type {
  BlameLine,
  CommitFileEntry,
  CommitSummary,
  DiffContent,
  DiffMode,
  WorkingStatus,
  ConflictContent,
  StashEntry,
} from "../types/git";

/** Thin, typed wrapper around the SCM-related Tauri command surface — same
 * pattern as `fsApi` in `src/api/fs.ts`. Mutating commands take both
 * `worktreeId` (to key the `scm://` event they emit on success) and
 * `worktreeRoot` (the absolute path, already held by the caller). */
export const gitApi = {
  getWorkingStatus: (worktreeRoot: string) =>
    invoke<WorkingStatus>("get_working_status", { worktreeRoot }),

  stagePaths: (worktreeId: string, worktreeRoot: string, relPaths: string[]) =>
    invoke<void>("stage_paths", { worktreeId, worktreeRoot, relPaths }),
  stageAll: (worktreeId: string, worktreeRoot: string) =>
    invoke<void>("stage_all", { worktreeId, worktreeRoot }),
  unstagePaths: (worktreeId: string, worktreeRoot: string, relPaths: string[]) =>
    invoke<void>("unstage_paths", { worktreeId, worktreeRoot, relPaths }),
  unstageAll: (worktreeId: string, worktreeRoot: string) =>
    invoke<void>("unstage_all", { worktreeId, worktreeRoot }),
  /** Stages (`unstage: false`) or unstages (`true`) exactly one hunk,
   * identified by its "new"-side line range — see `git.rs::stage_hunk`
   * for why that range is enough to find the right hunk without the
   * frontend needing to track a hunk id/index of its own. */
  stageHunk: (
    worktreeId: string,
    worktreeRoot: string,
    relPath: string,
    unstage: boolean,
    newStart: number,
    newEnd: number,
  ) =>
    invoke<void>("stage_hunk", {
      worktreeId,
      worktreeRoot,
      relPath,
      unstage,
      newStart,
      newEnd,
    }),
  discardChange: (worktreeId: string, worktreeRoot: string, relPath: string) =>
    invoke<void>("discard_change", { worktreeId, worktreeRoot, relPath }),
  discardPaths: (worktreeId: string, worktreeRoot: string, relPaths: string[]) =>
    invoke<void>("discard_paths", { worktreeId, worktreeRoot, relPaths }),

  commitChanges: (worktreeId: string, worktreeRoot: string, message: string) =>
    invoke<string>("commit_changes", { worktreeId, worktreeRoot, message }),
  pushChanges: (worktreeId: string, worktreeRoot: string) =>
    invoke<void>("push_changes", { worktreeId, worktreeRoot }),
  pullChanges: (worktreeId: string, worktreeRoot: string) =>
    invoke<void>("pull_changes", { worktreeId, worktreeRoot }),
  fetchRemote: (worktreeId: string, worktreeRoot: string) =>
    invoke<void>("fetch_remote", { worktreeId, worktreeRoot }),

  // `DiffMode`'s `#[serde(rename_all = "camelCase")]` already lowercases
  // the Rust variant names (`Unstaged` -> `"unstaged"`, etc.), matching
  // this module's `DiffMode` string union directly — no translation needed.
  getDiffContent: (worktreeRoot: string, relPath: string, mode: DiffMode, commitHash?: string) =>
    invoke<DiffContent>("get_diff_content", {
      worktreeRoot,
      relPath,
      mode,
      commitHash: commitHash ?? null,
    }),

  getBlame: (worktreeRoot: string, relPath: string) =>
    invoke<BlameLine[]>("get_blame", { worktreeRoot, relPath }),

  getCommitLog: (worktreeRoot: string, limit: number, skip: number) =>
    invoke<CommitSummary[]>("get_commit_log", { worktreeRoot, limit, skip }),
  getCommitFiles: (worktreeRoot: string, hash: string) =>
    invoke<CommitFileEntry[]>("get_commit_files", { worktreeRoot, hash }),

  getConflictContent: (worktreeRoot: string, relPath: string) =>
    invoke<ConflictContent>("get_conflict_content", { worktreeRoot, relPath }),
  resolveConflict: (worktreeId: string, worktreeRoot: string, relPath: string, result: string) =>
    invoke<void>("resolve_conflict", { worktreeId, worktreeRoot, relPath, result }),

  listStashes: (worktreeRoot: string) => invoke<StashEntry[]>("list_stashes", { worktreeRoot }),
  createStash: (
    worktreeId: string,
    worktreeRoot: string,
    message: string,
    includeUntracked = true,
  ) => invoke<void>("create_stash", { worktreeId, worktreeRoot, message, includeUntracked }),
  applyStash: (worktreeId: string, worktreeRoot: string, reference: string, pop: boolean) =>
    invoke<void>("apply_stash", { worktreeId, worktreeRoot, reference, pop }),
  dropStash: (worktreeRoot: string, reference: string) =>
    invoke<void>("drop_stash", { worktreeRoot, reference }),
  getStashFiles: (worktreeRoot: string, reference: string) =>
    invoke<CommitFileEntry[]>("get_stash_files", { worktreeRoot, reference }),
};
