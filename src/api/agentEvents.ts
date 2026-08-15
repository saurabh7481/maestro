import { listen } from "@tauri-apps/api/event";
import type { AgentEvent } from "../types/agent";

/** Subscribes to one agent run's event stream — emitted by
 * `agents/manager.rs::run_turn` on `agent://{runId}/event`. Mirrors
 * `scmEvents.ts`'s pattern. */
export function listenToAgentEvents(runId: string, onEvent: (event: AgentEvent) => void) {
  return listen<AgentEvent>(`agent://${runId}/event`, (event) => {
    // Defensive against a malformed/undefined payload — see `fsEvents.ts`.
    if (event?.payload) onEvent(event.payload);
  });
}
