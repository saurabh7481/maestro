import { listen } from "@tauri-apps/api/event";
import type { AgentEvent, AgentKind } from "../types/agent";

/** Subscribes to one agent run's event stream — emitted by
 * `agents/manager.rs::run_turn` on `agent://{runId}/event`. Mirrors
 * `scmEvents.ts`'s pattern. */
export function listenToAgentEvents(runId: string, onEvent: (event: AgentEvent) => void) {
  return listen<AgentEvent>(`agent://${runId}/event`, (event) => {
    // Defensive against a malformed/undefined payload — see `fsEvents.ts`.
    if (event?.payload) onEvent(event.payload);
  });
}

export interface AgentSessionCreated {
  runId: string;
  worktreeId: string;
  worktreeRoot: string;
  kind: AgentKind;
}

/** Subscribes to the fixed, non-id-parameterized channel
 * `agents/manager.rs::start_agent_session`/`resume_agent_session` emit on
 * whenever a new run is created — regardless of whether it was this
 * window's own tab-creation flow or an external caller (the mobile
 * relay). Unlike `listenToAgentEvents`, this is a single, app-lifetime
 * subscription (see `AppShell.tsx`'s `useRelaySessionSync`), not one per
 * open tab, since its whole purpose is to learn about runs no tab exists
 * for yet. */
export function listenToAgentSessionCreated(onEvent: (event: AgentSessionCreated) => void) {
  return listen<AgentSessionCreated>("agent-sessions://created", (event) => {
    if (event?.payload) onEvent(event.payload);
  });
}

export interface AgentSessionTitled {
  runId: string;
  title: string;
}

/** Fires once `agents/manager.rs::spawn_title_generation` has a short
 * title for a run's first message — see `AppShell.tsx`'s
 * `useRelaySessionSync`, which renames the matching tab on it. A
 * single, app-lifetime subscription, same shape as
 * `listenToAgentSessionCreated`. */
export function listenToAgentSessionTitled(onEvent: (event: AgentSessionTitled) => void) {
  return listen<AgentSessionTitled>("agent-sessions://titled", (event) => {
    if (event?.payload) onEvent(event.payload);
  });
}
