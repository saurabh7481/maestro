import { listen } from "@tauri-apps/api/event";
import type { FsChangeEvent } from "../types/fs";

/** Subscribes to a worktree's file-watcher events (started/stopped via
 * `fsApi.startWorktreeWatcher`/`stopWorktreeWatcher`). Mirrors
 * `hookEvents.ts`'s pattern. Returns the unlisten function (async, per
 * `@tauri-apps/api/event`). */
export function listenToFsEvents(worktreeId: string, onEvent: (event: FsChangeEvent) => void) {
  return listen<FsChangeEvent>(`fs://${worktreeId}`, (event) => onEvent(event.payload));
}
