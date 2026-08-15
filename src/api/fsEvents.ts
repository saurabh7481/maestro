import { listen } from "@tauri-apps/api/event";
import type { FsChangeEvent } from "../types/fs";

/** Subscribes to a worktree's file-watcher events (started/stopped via
 * `fsApi.startWorktreeWatcher`/`stopWorktreeWatcher`). Mirrors
 * `hookEvents.ts`'s pattern. Returns the unlisten function (async, per
 * `@tauri-apps/api/event`). */
export function listenToFsEvents(worktreeId: string, onEvent: (event: FsChangeEvent) => void) {
  return listen<FsChangeEvent>(`fs://${worktreeId}`, (event) => {
    // Defensive: seen live with `event.payload` undefined under a burst
    // of rapid-fire watcher events (self-hosting this repo's own worktree
    // while `cargo`/`vite` churn files makes this easy to hit) — the
    // exact IPC-layer cause isn't nailed down yet, but a malformed event
    // should never crash the whole renderer over a dropped fs
    // notification. Same guard applied to every `listen*Events` wrapper.
    if (event?.payload) onEvent(event.payload);
  });
}
