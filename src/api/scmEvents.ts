import { listen } from "@tauri-apps/api/event";
import type { ScmEvent } from "../types/git";

/** Subscribes to a worktree's SCM status events — emitted both by the file
 * watcher (`watcher.rs`, off working-tree edits) and directly by every
 * mutating git command (`commands/git.rs`, since `.git/` itself is
 * watcher-ignored and staging/committing/pushing would otherwise never be
 * seen). Mirrors `fsEvents.ts`'s pattern. */
export function listenToScmEvents(worktreeId: string, onEvent: (event: ScmEvent) => void) {
  return listen<ScmEvent>(`scm://${worktreeId}`, (event) => onEvent(event.payload));
}
