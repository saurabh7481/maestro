import { listen } from "@tauri-apps/api/event";
import type { SearchEvent } from "../types/search";

/** Subscribes to one in-flight search's streamed match/done events.
 * Returns the unlisten function (async, per @tauri-apps/api/event). */
export function listenToSearchEvents(searchId: string, onEvent: (event: SearchEvent) => void) {
  return listen<SearchEvent>(`search://${searchId}`, (event) => {
    // Defensive against a malformed/undefined payload — see `fsEvents.ts`.
    if (event?.payload) onEvent(event.payload);
  });
}
