/** Mirrors `src-tauri/src/processes.rs` — the Process Manager's view of
 * every OS process Maestro spawned (docs/V2_ROADMAP.md Phase 15). */

export type ManagedProcessKind = "agent" | "terminal" | "languageServer" | "hook";

/** `idle` is an agent tab with no turn in flight: the run exists, the tab
 * exists, but there is no child process — which is why nothing is
 * killable in that state. `exited` means the pid is gone but Maestro's
 * own bookkeeping hasn't caught up yet. */
export type ManagedProcessStatus = "running" | "idle" | "exited";

export interface ManagedProcess {
  id: string;
  kind: ManagedProcessKind;
  label: string;
  detail: string | null;
  worktreeId: string | null;
  worktreeRoot: string | null;
  /** Present only for agent/terminal processes, whose ids *are* tab ids. */
  tabId: string | null;
  pid: number | null;
  startedAtMs: number;
  status: ManagedProcessStatus;
  /** Percent of one core, summed across the process and its descendants —
   * can legitimately exceed 100 on a multi-core machine. */
  cpuPercent: number;
  memoryBytes: number;
  childProcessCount: number;
  killable: boolean;
}

export interface ProcessSnapshot {
  processes: ManagedProcess[];
  sampledAtMs: number;
  cpuCoreCount: number;
  totalMemoryBytes: number;
  /** False on the first sample after launch — CPU usage is a delta
   * between two samples, so there is nothing to report yet. */
  cpuReady: boolean;
}

export const PROCESS_KIND_LABEL: Record<ManagedProcessKind, string> = {
  agent: "Agent",
  terminal: "Terminal",
  languageServer: "Language server",
  hook: "Hook",
};

/** Plural form for group headings and summary counts. */
export const PROCESS_KIND_PLURAL: Record<ManagedProcessKind, string> = {
  agent: "Agents",
  terminal: "Terminals",
  languageServer: "Language servers",
  hook: "Hooks",
};

export const PROCESS_KIND_ORDER: ManagedProcessKind[] = [
  "agent",
  "terminal",
  "languageServer",
  "hook",
];
