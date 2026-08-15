import { invoke } from "@tauri-apps/api/core";
import type { ManagedProcessKind, ProcessSnapshot } from "../types/process";

/** Thin, typed wrapper around `processes.rs` — same pattern as
 * `terminalApi`/`agentsApi`. */
export const processesApi = {
  list: () => invoke<ProcessSnapshot>("list_managed_processes"),
  kill: (kind: ManagedProcessKind, id: string) =>
    invoke<void>("kill_managed_process", { kind, id }),
};
