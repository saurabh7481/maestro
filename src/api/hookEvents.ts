import { listen } from "@tauri-apps/api/event";
import type { HookEvent } from "../types/workspace";

/** Subscribes to a running hook's streamed output/completion events.
 * Returns the unlisten function (async, per @tauri-apps/api/event). */
export function listenToHookEvents(worktreeId: string, onEvent: (event: HookEvent) => void) {
  return listen<HookEvent>(`hook://${worktreeId}`, (event) => onEvent(event.payload));
}
