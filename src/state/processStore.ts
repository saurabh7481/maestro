import { useEffect } from "react";
import { create } from "zustand";
import { processesApi } from "../api/processes";
import type { ManagedProcess, ManagedProcessKind, ProcessSnapshot } from "../types/process";

/** How often the Process Manager re-samples while something is watching.
 * Two seconds is fast enough that a killed process visibly disappears and
 * a busy agent's CPU number moves, and slow enough that the sweep (one
 * `/proc` walk per poll) never shows up in a profile. */
const POLL_INTERVAL_MS = 2000;

interface ProcessState {
  snapshot: ProcessSnapshot | null;
  /** Last poll's failure, if any — kept alongside the previous snapshot
   * rather than replacing it, so a transient IPC error doesn't blank a
   * table the user is reading. */
  error: string | null;
  /** Ids currently being killed, so a row can show progress and not be
   * double-clicked into two kill requests. Keyed `kind:id`, since the two
   * together are what makes a process unique. */
  killing: string[];

  refresh: () => Promise<void>;
  kill: (process: ManagedProcess) => Promise<void>;
  /** Reference-counted polling: nothing polls unless the Process Manager
   * tab or its status-bar popover is actually open. */
  acquire: () => void;
  release: () => void;
}

export function processKey(kind: ManagedProcessKind, id: string): string {
  return `${kind}:${id}`;
}

let watcherCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export const useProcessStore = create<ProcessState>((set, get) => ({
  snapshot: null,
  error: null,
  killing: [],

  refresh: async () => {
    try {
      const snapshot = await processesApi.list();
      set({ snapshot, error: null });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  kill: async (process) => {
    const key = processKey(process.kind, process.id);
    if (get().killing.includes(key)) return;
    set((s) => ({ killing: [...s.killing, key] }));
    try {
      await processesApi.kill(process.kind, process.id);
      // Re-poll immediately rather than waiting out the interval — the
      // whole point of the button is that the row visibly reacts.
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set((s) => ({ killing: s.killing.filter((entry) => entry !== key) }));
    }
  },

  acquire: () => {
    watcherCount += 1;
    if (watcherCount > 1) return;
    void get().refresh();
    timer = setInterval(() => void get().refresh(), POLL_INTERVAL_MS);
  },

  release: () => {
    watcherCount = Math.max(0, watcherCount - 1);
    if (watcherCount > 0 || !timer) return;
    clearInterval(timer);
    timer = null;
  },
}));

/** Keeps the shared poll alive for as long as the calling component is
 * mounted. Several components can hold it at once (the tab and the
 * popover, say) and only one poll runs. */
export function useProcessPolling(enabled = true): void {
  const acquire = useProcessStore((s) => s.acquire);
  const release = useProcessStore((s) => s.release);
  useEffect(() => {
    if (!enabled) return;
    acquire();
    return () => release();
  }, [enabled, acquire, release]);
}

/** Processes worth drawing attention to in the status bar: anything with
 * a live child process. Idle agent tabs are excluded — they're a tab, not
 * a running process, and counting them would make the badge meaningless. */
export function runningProcesses(snapshot: ProcessSnapshot | null): ManagedProcess[] {
  return (snapshot?.processes ?? []).filter((process) => process.status === "running");
}

export function totalCpuPercent(processes: ManagedProcess[]): number {
  return processes.reduce((sum, process) => sum + process.cpuPercent, 0);
}

export function totalMemoryBytes(processes: ManagedProcess[]): number {
  return processes.reduce((sum, process) => sum + process.memoryBytes, 0);
}
