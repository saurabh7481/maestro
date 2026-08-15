import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PtyEvent } from "../types/terminal";

/** Thin, typed wrapper around the terminal Tauri command surface — same
 * pattern as `gitApi`/`agentsApi`. */
export const terminalApi = {
  spawn: (terminalId: string, worktreePath: string, rows: number, cols: number) =>
    invoke<void>("spawn_terminal", { terminalId, worktreePath, rows, cols }),
  write: (terminalId: string, data: string) => invoke<void>("write_terminal", { terminalId, data }),
  resize: (terminalId: string, rows: number, cols: number) =>
    invoke<void>("resize_terminal", { terminalId, rows, cols }),
  kill: (terminalId: string) => invoke<void>("kill_terminal", { terminalId }),
};

/** Subscribes to one terminal's PTY output — emitted by
 * `terminal.rs::spawn_terminal` on `pty://{terminalId}/data`. Mirrors
 * `agentEvents.ts`'s pattern. */
export function listenToPtyEvents(terminalId: string, onEvent: (event: PtyEvent) => void) {
  return listen<PtyEvent>(`pty://${terminalId}/data`, (event) => {
    // Defensive against a malformed/undefined payload — see `fsEvents.ts`.
    if (event?.payload) onEvent(event.payload);
  });
}
