import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowSquareOut,
  Pulse,
  Sparkle,
  StopCircle,
  TerminalWindow,
  TreeStructure,
  Wrench,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { formatBytes } from "../../editor/formatBytes";
import { ICON_SIZE } from "../../design/iconSize";
import {
  processKey,
  runningProcesses,
  totalCpuPercent,
  useProcessPolling,
  useProcessStore,
} from "../../state/processStore";
import { revealTab } from "../../state/tabNavigation";
import type { ManagedProcessKind } from "../../types/process";
import { formatCpu, worktreeLabel } from "./processRows";
import { openProcessesTab } from "./openProcessesTab";
import styles from "./ProcessPopover.module.css";

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

/** The quick half of the Process Manager: a status-bar popover listing
 * what's running right now with a kill button per row, for the "something
 * is chewing my CPU, stop it" case that shouldn't cost a tab
 * (docs/V2_ROADMAP.md Phase 15). The full tab is one click away at the
 * bottom.
 *
 * Only polls while open — the shared refcount in `processStore` means the
 * popover and the tab together still run a single poll. */
export function ProcessPopover() {
  const [open, setOpen] = useState(false);
  useProcessPolling(open);

  const snapshot = useProcessStore((s) => s.snapshot);
  const killing = useProcessStore((s) => s.killing);
  const kill = useProcessStore((s) => s.kill);
  const running = runningProcesses(snapshot);
  const cpu = totalCpuPercent(running);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          data-active={open}
          aria-label={`Processes — ${running.length} running`}
          title="Processes"
        >
          <Pulse size={ICON_SIZE.xs} />
          {running.length > 0 && <span className={styles.triggerCount}>{running.length}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${styles.panel} mo-glass`}
          align="end"
          side="top"
          sideOffset={8}
        >
          <div className={styles.header}>
            <span className={styles.headerTitle}>Running processes</span>
            <span className={styles.headerMeta}>
              {snapshot?.cpuReady ? formatCpu(cpu) : "measuring…"} CPU
            </span>
          </div>

          {running.length === 0 ? (
            <div className={styles.empty}>
              Nothing running. Agents, terminals, language servers and hooks show up here while they
              work.
            </div>
          ) : (
            <div className={styles.list}>
              {running.map((process) => {
                const KindIcon = KIND_ICON[process.kind];
                const key = processKey(process.kind, process.id);
                return (
                  <div key={key} className={styles.row}>
                    <span className={styles.rowIcon} style={{ color: KIND_COLOR[process.kind] }}>
                      <KindIcon size={ICON_SIZE.sm} />
                    </span>
                    <div className={styles.rowText}>
                      <div className={styles.rowName}>{process.label}</div>
                      <div className={styles.rowMeta}>
                        {worktreeLabel(process.worktreeRoot)} ·{" "}
                        {snapshot?.cpuReady ? formatCpu(process.cpuPercent) : "—"} ·{" "}
                        {formatBytes(process.memoryBytes)}
                      </div>
                    </div>
                    {process.tabId && (
                      <button
                        type="button"
                        className={styles.action}
                        title="Show this tab"
                        aria-label={`Show ${process.label} tab`}
                        onClick={() => {
                          revealTab(process.tabId!);
                          setOpen(false);
                        }}
                      >
                        <ArrowSquareOut size={ICON_SIZE.sm} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${styles.action} ${styles.kill}`}
                      disabled={killing.includes(key)}
                      title={
                        process.kind === "agent"
                          ? "Stop this agent's current turn"
                          : `Kill ${process.label}`
                      }
                      aria-label={`Kill ${process.label}`}
                      onClick={() => void kill(process)}
                    >
                      <StopCircle size={ICON_SIZE.sm} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            className={styles.footer}
            onClick={() => {
              openProcessesTab();
              setOpen(false);
            }}
          >
            Open Process Manager
          </button>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
