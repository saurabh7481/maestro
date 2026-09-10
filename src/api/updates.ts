import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ReleaseOption {
  tag: string;
  name: string;
  publishedAt: string;
}

/** Streamed over `update://{opId}` by the `revert_to_version` Tauri
 * command — same shape convention as `hookEvents.ts`/`cloneEvents.ts`. */
export type RevertEvent =
  | { type: "progress"; downloaded: number; total: number | null }
  | { type: "done"; success: boolean; error: string | null };

/** Thin, typed wrapper around the update-related Tauri command surface —
 * same pattern as `workspaceApi`/`agentsApi`. Checking/downloading/
 * installing the *latest* version doesn't go through here at all — that's
 * `@tauri-apps/plugin-updater`'s own JS API, called directly from
 * `AboutPane.tsx`. */
export const updatesApi = {
  listReleases: () => invoke<ReleaseOption[]>("list_releases"),
  revertToVersion: (opId: string, tag: string) => invoke<void>("revert_to_version", { opId, tag }),
};

export function listenToRevertEvents(opId: string, onEvent: (event: RevertEvent) => void) {
  return listen<RevertEvent>(`update://${opId}`, (event) => {
    // Defensive against a malformed/undefined payload — see `fsEvents.ts`.
    if (event?.payload) onEvent(event.payload);
  });
}
