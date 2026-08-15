import {
  PROCESS_KIND_ORDER,
  type ManagedProcess,
  type ManagedProcessKind,
} from "../../types/process";

/** Pure view-model helpers for the Process Manager, kept out of the
 * component for the same reason `search/resultRows.ts` and
 * `chrome/scmRows.ts` are: grouping and formatting rules are worth
 * testing directly, and a table that re-derives them inline on every
 * 2-second poll is where a list view quietly gets slow. */

export interface ProcessGroup {
  kind: ManagedProcessKind;
  processes: ManagedProcess[];
  /** Only processes with a live child — the number the heading shows as
   * "3 running" while a dead-but-not-yet-reaped row is still listed. */
  runningCount: number;
}

/** Compact uptime — `12s`, `4m 20s`, `3h 07m`, `2d 4h`. Deliberately not
 * `relativeTime`'s "5h ago" phrasing: this is a duration a process has
 * been alive, not a point in the past, and the seconds matter for a
 * process that just started. */
export function formatUptime(startedAtMs: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - startedAtMs);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One decimal below 10%, none above — a process bouncing between 43% and
 * 44% shouldn't also be jittering an extra digit every poll. */
export function formatCpu(percent: number): string {
  if (percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** The last path segment of a worktree root, which is what actually
 * distinguishes two worktrees of the same project at a glance. Callers
 * that can resolve the real branch name (via `workspaceStore`) should
 * prefer that; this is the fallback for a path with no known worktree. */
export function worktreeLabel(worktreeRoot: string | null): string {
  if (!worktreeRoot) return "—";
  const segments = worktreeRoot.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? worktreeRoot;
}

/** Groups by kind in a fixed order (agents first — they're what a user
 * looking at this tab is usually hunting for), dropping empty groups so
 * the table has no headings with nothing under them. Within a group,
 * running processes sort above idle/exited ones, then newest first. */
export function groupProcesses(processes: ManagedProcess[]): ProcessGroup[] {
  const statusRank: Record<ManagedProcess["status"], number> = { running: 0, idle: 1, exited: 2 };
  return PROCESS_KIND_ORDER.map((kind) => {
    const matching = processes
      .filter((process) => process.kind === kind)
      .sort((a, b) => statusRank[a.status] - statusRank[b.status] || b.startedAtMs - a.startedAtMs);
    return {
      kind,
      processes: matching,
      runningCount: matching.filter((process) => process.status === "running").length,
    };
  }).filter((group) => group.processes.length > 0);
}

/** Case-insensitive match across the fields a user would actually type:
 * the process name, its detail line, the worktree it belongs to, and its
 * pid. */
export function filterProcesses(processes: ManagedProcess[], query: string): ManagedProcess[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return processes;
  return processes.filter((process) =>
    [
      process.label,
      process.detail ?? "",
      process.worktreeRoot ?? "",
      process.pid == null ? "" : String(process.pid),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
