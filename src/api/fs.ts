import { invoke } from "@tauri-apps/api/core";
import type { FileReadResult, FsEntry, WriteResult } from "../types/fs";

/** Thin, typed wrapper around the fs-related Tauri command surface — same
 * pattern as `workspaceApi` in `src/api/workspace.ts`. Every command takes
 * the worktree's absolute root path directly (already held by the caller
 * via `workspaceStore`), so there's no DB round-trip needed on this side. */
export const fsApi = {
  listDir: (worktreeRoot: string, relDir: string) =>
    invoke<FsEntry[]>("list_dir", { worktreeRoot, relDir }),
  readFile: (worktreeRoot: string, relPath: string) =>
    invoke<FileReadResult>("read_file", { worktreeRoot, relPath }),
  writeFile: (worktreeRoot: string, relPath: string, content: string, expectedMtimeMs?: number) =>
    invoke<WriteResult>("write_file", {
      worktreeRoot,
      relPath,
      content,
      expectedMtimeMs: expectedMtimeMs ?? null,
    }),
  createEntry: (worktreeRoot: string, relPath: string, isDir: boolean) =>
    invoke<void>("create_entry", { worktreeRoot, relPath, isDir }),
  renameEntry: (worktreeRoot: string, fromRel: string, toRel: string) =>
    invoke<void>("rename_entry", { worktreeRoot, fromRel, toRel }),
  deleteEntry: (worktreeRoot: string, relPath: string) =>
    invoke<void>("delete_entry", { worktreeRoot, relPath }),
  getStatusMap: (worktreeRoot: string) =>
    invoke<Record<string, string>>("get_status_map", { worktreeRoot }),

  startWorktreeWatcher: (worktreeId: string, worktreePath: string) =>
    invoke<void>("start_worktree_watcher", { worktreeId, worktreePath }),
  stopWorktreeWatcher: (worktreeId: string) =>
    invoke<void>("stop_worktree_watcher", { worktreeId }),
};
