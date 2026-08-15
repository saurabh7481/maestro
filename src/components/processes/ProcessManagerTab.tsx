import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  Cpu,
  Empty,
  MagnifyingGlass,
  Memory,
  Pulse,
  Sparkle,
  StopCircle,
  TerminalWindow,
  TreeStructure,
  Wrench,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import {
  PROCESS_KIND_ORDER,
  PROCESS_KIND_PLURAL,
  type ManagedProcess,
  type ManagedProcessKind,
} from "../../types/process";
import {
  processKey,
  runningProcesses,
  totalCpuPercent,
  totalMemoryBytes,
  useProcessPolling,
  useProcessStore,
} from "../../state/processStore";
import { useTabsStore } from "../../state/tabsStore";
import { revealTab } from "../../state/tabNavigation";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { formatBytes } from "../../editor/formatBytes";
import { ICON_SIZE } from "../../design/iconSize";
import {
  filterProcesses,
  formatCpu,
  formatUptime,
  groupProcesses,
  worktreeLabel,
} from "./processRows";
import styles from "./ProcessManagerTab.module.css";

const KIND_ICON: Record<ManagedProcessKind, Icon> = {
  agent: Sparkle,
  terminal: TerminalWindow,
  languageServer: TreeStructure,
  hook: Wrench,
};

const KIND_COLOR: Record<ManagedProcessKind, string> = {
  agent: "var(--accent)",
  terminal: "var(--green)",
  languageServer: "var(--blue)",
  hook: "var(--orange)",
};

/** How long an armed kill button stays armed before disarming itself. A
 * kill is irreversible and this table is dense enough that a stray click
 * is plausible, so the button asks once — inline, rather than through a
 * modal that would make killing five stale servers a five-dialog chore. */
const CONFIRM_TIMEOUT_MS = 4000;

/** Process Manager tab (docs/V2_ROADMAP.md Phase 15) — every OS process
 * Maestro spawned, across every project and worktree, with what it costs
 * and a way to kill it. The data comes from `processes.rs`, which reads
 * the same `AppState` bookkeeping the agent/terminal/LSP/hook lifecycles
 * already maintain; this view adds no lifecycle of its own. */
export function ProcessManagerTab() {
  useProcessPolling();
  const snapshot = useProcessStore((s) => s.snapshot);
  const error = useProcessStore((s) => s.error);
  const killing = useProcessStore((s) => s.killing);
  const kill = useProcessStore((s) => s.kill);

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<ManagedProcessKind | "all">("all");
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const all = useMemo(() => snapshot?.processes ?? [], [snapshot]);
  const visible = useMemo(() => {
    const byKind = kindFilter === "all" ? all : all.filter((p) => p.kind === kindFilter);
    return filterProcesses(byKind, query);
  }, [all, kindFilter, query]);
  const groups = useMemo(() => groupProcesses(visible), [visible]);

  const running = runningProcesses(snapshot);
  const cpuTotal = totalCpuPercent(running);
  const memoryTotal = totalMemoryBytes(running);
  const cores = snapshot?.cpuCoreCount ?? 0;
  const machineMemory = snapshot?.totalMemoryBytes ?? 0;
  // `sampledAtMs` rather than `Date.now()`: uptimes then tick in lockstep
  // with the data they're describing instead of drifting a second ahead of
  // it between polls. Zero before the first sample lands — which is also
  // the only time there are no rows to render a duration for.
  const now = snapshot?.sampledAtMs ?? 0;

  const countsByKind = useMemo(() => {
    const counts = {} as Record<ManagedProcessKind, number>;
    for (const kind of PROCESS_KIND_ORDER) {
      counts[kind] = all.filter((p) => p.kind === kind).length;
    }
    return counts;
  }, [all]);

  return (
    <div className={styles.tab}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Processes</h1>
          <p className={styles.subtitle}>
            Everything Maestro has started — agents, terminals, language servers and worktree hooks
            — across every project.
          </p>
        </div>
        <div
          className={styles.live}
          title={
            now > 0
              ? `Sampled every 2s · last at ${new Date(now).toLocaleTimeString()}`
              : "Sampling…"
          }
        >
          <span className={styles.liveDot} />
          live
        </div>
      </header>

      <div className={styles.stats}>
        <StatCard
          icon={Pulse}
          color="var(--green)"
          label="Running"
          value={String(running.length)}
          note={`${all.length} tracked in total`}
        />
        <StatCard
          icon={Cpu}
          color="var(--accent)"
          label="CPU"
          value={snapshot?.cpuReady ? formatCpu(cpuTotal) : "measuring…"}
          note={cores > 0 ? `across ${cores} cores` : "—"}
          meter={cores > 0 && snapshot?.cpuReady ? cpuTotal / (cores * 100) : undefined}
        />
        <StatCard
          icon={Memory}
          color="var(--blue)"
          label="Memory"
          value={formatBytes(memoryTotal)}
          note={machineMemory > 0 ? `of ${formatBytes(machineMemory)} installed` : "—"}
          meter={machineMemory > 0 ? memoryTotal / machineMemory : undefined}
        />
        <StatCard
          icon={TreeStructure}
          color="var(--purple)"
          label="Child processes"
          value={String(running.reduce((sum, p) => sum + p.childProcessCount, 0))}
          note="spawned by the above"
        />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <MagnifyingGlass size={ICON_SIZE.sm} color="var(--text-mute)" />
          <input
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, pid, worktree…"
            aria-label="Filter processes"
            spellCheck={false}
          />
        </div>
        <div className={styles.chips}>
          <button
            type="button"
            className={styles.chip}
            data-active={kindFilter === "all"}
            onClick={() => setKindFilter("all")}
          >
            All <span className={styles.chipCount}>{all.length}</span>
          </button>
          {PROCESS_KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              className={styles.chip}
              data-active={kindFilter === kind}
              onClick={() => setKindFilter(kind)}
              disabled={countsByKind[kind] === 0}
            >
              {PROCESS_KIND_PLURAL[kind]}{" "}
              <span className={styles.chipCount}>{countsByKind[kind]}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <div className={styles.error}>Couldn't read the process list — {error}</div>}

      <div className={styles.scroller}>
        {groups.length === 0 ? (
          <div className={styles.empty}>
            <Empty size={26} color="var(--text-mute)" />
            <div className={styles.emptyTitle}>
              {all.length === 0 ? "Nothing running" : "No process matches that filter"}
            </div>
            <div className={styles.emptyNote}>
              {all.length === 0
                ? "Agent tabs, terminals, language servers and worktree hooks appear here as soon as they start."
                : "Clear the filter to see everything Maestro has started."}
            </div>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.kind} className={styles.group}>
              <div className={styles.groupHeader}>
                <span className={styles.groupTitle}>{PROCESS_KIND_PLURAL[group.kind]}</span>
                <span className={styles.groupCount}>
                  {group.runningCount} running · {group.processes.length} tracked
                </span>
              </div>
              <div className={styles.rowHeader}>
                <span>Process</span>
                <span>Worktree</span>
                <span>Status</span>
                <span className={styles.numeric}>PID</span>
                <span className={styles.numeric}>Uptime</span>
                <span className={styles.numeric}>CPU</span>
                <span className={styles.numeric}>Memory</span>
                <span />
              </div>
              {group.processes.map((process) => (
                <ProcessRow
                  key={processKey(process.kind, process.id)}
                  process={process}
                  now={now}
                  cores={cores}
                  cpuReady={snapshot?.cpuReady ?? false}
                  busy={killing.includes(processKey(process.kind, process.id))}
                  armed={armed === processKey(process.kind, process.id)}
                  onArm={() => setArmed(processKey(process.kind, process.id))}
                  onKill={() => {
                    setArmed(null);
                    void kill(process);
                  }}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: IconComponent,
  color,
  label,
  value,
  note,
  meter,
}: {
  icon: Icon;
  color: string;
  label: string;
  value: string;
  note: string;
  /** 0–1; renders a fill bar under the value when the number has a
   * meaningful ceiling (CPU against core count, memory against installed
   * RAM). Omitted where a ratio would be invented rather than measured. */
  meter?: number;
}) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statTop}>
        <span className={styles.statIcon} style={{ color }}>
          <IconComponent size={ICON_SIZE.md} />
        </span>
        <span className={styles.statLabel}>{label}</span>
      </div>
      <div className={styles.statValue}>{value}</div>
      {meter != null && (
        <div className={styles.statMeter}>
          <span
            className={styles.statMeterFill}
            style={{ width: `${Math.min(100, Math.max(0, meter * 100))}%`, background: color }}
          />
        </div>
      )}
      <div className={styles.statNote}>{note}</div>
    </div>
  );
}

function ProcessRow({
  process,
  now,
  cores,
  cpuReady,
  busy,
  armed,
  onArm,
  onKill,
}: {
  process: ManagedProcess;
  now: number;
  cores: number;
  cpuReady: boolean;
  busy: boolean;
  armed: boolean;
  onArm: () => void;
  onKill: () => void;
}) {
  const KindIcon = KIND_ICON[process.kind];
  const tabs = useTabsStore((s) => s.tabs);
  const worktrees = useWorkspaceStore((s) => s.worktreesByProject);

  // Prefer the real branch name over the directory basename — that's what
  // the rest of the app labels a worktree by (sidebar, status bar, tab
  // titles), and two worktrees can share a directory name across projects.
  const branch = useMemo(() => {
    if (!process.worktreeRoot) return null;
    for (const list of Object.values(worktrees)) {
      const match = list.find((worktree) => worktree.path === process.worktreeRoot);
      if (match) return match.branch;
    }
    return null;
  }, [worktrees, process.worktreeRoot]);

  const linkedTab = process.tabId ? tabs.find((tab) => tab.id === process.tabId) : undefined;
  const cpuRatio = cores > 0 ? process.cpuPercent / (cores * 100) : 0;

  return (
    <div className={styles.row} data-status={process.status}>
      <div className={styles.cellName}>
        <span className={styles.rowIcon} style={{ color: KIND_COLOR[process.kind] }}>
          <KindIcon size={ICON_SIZE.md} />
        </span>
        <div className={styles.nameText}>
          <div className={styles.name}>
            {process.label}
            {process.childProcessCount > 0 && (
              <span
                className={styles.childBadge}
                title={`${process.childProcessCount} child process${
                  process.childProcessCount === 1 ? "" : "es"
                } included in these numbers`}
              >
                +{process.childProcessCount}
              </span>
            )}
          </div>
          {process.detail && <div className={styles.detail}>{process.detail}</div>}
        </div>
      </div>

      <div className={styles.cellWorktree} title={process.worktreeRoot ?? undefined}>
        {branch ?? worktreeLabel(process.worktreeRoot)}
      </div>

      <div className={styles.cellStatus}>
        <span className={styles.status} data-status={process.status}>
          {process.status === "idle" ? "idle" : process.status === "exited" ? "exited" : "running"}
        </span>
      </div>

      <div className={`${styles.cell} ${styles.numeric} ${styles.mono}`}>{process.pid ?? "—"}</div>
      <div className={`${styles.cell} ${styles.numeric} ${styles.mono}`}>
        {formatUptime(process.startedAtMs, now)}
      </div>

      <div className={`${styles.cell} ${styles.numeric}`}>
        <div className={styles.cpuCell}>
          <span className={styles.mono}>{cpuReady ? formatCpu(process.cpuPercent) : "—"}</span>
          <span className={styles.cpuMeter}>
            <span
              className={styles.cpuMeterFill}
              style={{ width: `${Math.min(100, Math.max(0, cpuRatio * 100))}%` }}
            />
          </span>
        </div>
      </div>

      <div className={`${styles.cell} ${styles.numeric} ${styles.mono}`}>
        {process.memoryBytes > 0 ? formatBytes(process.memoryBytes) : "—"}
      </div>

      <div className={styles.cellActions}>
        {linkedTab && (
          <button
            type="button"
            className={styles.action}
            title="Show the tab this process belongs to"
            aria-label={`Show ${process.label} tab`}
            onClick={() => revealTab(linkedTab.id)}
          >
            <ArrowSquareOut size={ICON_SIZE.sm} />
          </button>
        )}
        {process.killable && (
          <button
            type="button"
            className={`${styles.action} ${styles.kill}`}
            data-armed={armed}
            disabled={busy}
            title={
              process.kind === "agent"
                ? "Stop this agent's current turn"
                : `Kill ${process.label}${
                    process.childProcessCount > 0 ? " and its child processes" : ""
                  }`
            }
            onClick={() => (armed ? onKill() : onArm())}
          >
            {armed ? (
              <span className={styles.killConfirm}>Kill?</span>
            ) : (
              <StopCircle size={ICON_SIZE.sm} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
