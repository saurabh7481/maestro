import { invoke } from "@tauri-apps/api/core";
import type {
  CommitFileEntry,
  CommitSummary,
  DiffContent,
  DiffMode,
  WorkingStatus,
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
  discardChange: (worktreeId: string, worktreeRoot: string, relPath: string) =>
    invoke<void>("discard_change", { worktreeId, worktreeRoot, relPath }),

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

  getCommitLog: (worktreeRoot: string, limit: number, skip: number) =>
    invoke<CommitSummary[]>("get_commit_log", { worktreeRoot, limit, skip }),
  getCommitFiles: (worktreeRoot: string, hash: string) =>
    invoke<CommitFileEntry[]>("get_commit_files", { worktreeRoot, hash }),
};
