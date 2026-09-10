import { listen } from "@tauri-apps/api/event";
import type { CloneEvent } from "../types/workspace";

/** Subscribes to a running `git clone`'s streamed output/completion events —
 * same shape as `hookEvents.ts::listenToHookEvents`. Returns the unlisten
 * function (async, per @tauri-apps/api/event). */
export function listenToCloneEvents(cloneId: string, onEvent: (event: CloneEvent) => void) {
  return listen<CloneEvent>(`clone://${cloneId}`, (event) => {
    // Defensive against a malformed/undefined payload — see `fsEvents.ts`.
    if (event?.payload) onEvent(event.payload);
  });
}
