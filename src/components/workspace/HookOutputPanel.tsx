import { useEffect, useRef } from "react";
import { CheckCircle, Clock, Prohibit, SpinnerGap, XCircle } from "@phosphor-icons/react";
import styles from "./HookOutputPanel.module.css";

export type HookRunStatus = "running" | "success" | "failed" | "cancelled" | "timedOut";

export interface HookOutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

const STATUS_META: Record<HookRunStatus, { label: string; color: string }> = {
  running: { label: "Running post-create hook…", color: "var(--accent)" },
  success: { label: "Hook completed", color: "var(--green)" },
  failed: { label: "Hook failed", color: "var(--red)" },
  cancelled: { label: "Hook cancelled", color: "var(--text-mute)" },
  timedOut: { label: "Hook timed out after 120s", color: "var(--orange)" },
};

export function HookOutputPanel({
  status,
  lines,
  labels,
  emptyText = "No hooks configured for this project.",
}: {
  status: HookRunStatus;
  lines: HookOutputLine[];
  /** Overrides `STATUS_META`'s hook-specific copy per status — e.g. the
   * clone dialog (`CloneProjectDialog.tsx`) shows "Cloning…"/"Clone
   * completed"/etc. instead, reusing this panel rather than duplicating it.
   * `timedOut` never applies there (clone has no fixed timeout). */
  labels?: Partial<Record<HookRunStatus, string>>;
  emptyText?: string;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const meta = STATUS_META[status];
  const label = labels?.[status] ?? meta.label;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines.length]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        {status === "running" && <SpinnerGap size={15} color={meta.color} className="mo-spin" />}
        {status === "success" && <CheckCircle size={15} color={meta.color} weight="fill" />}
        {status === "failed" && <XCircle size={15} color={meta.color} weight="fill" />}
        {status === "cancelled" && <Prohibit size={15} color={meta.color} />}
        {status === "timedOut" && <Clock size={15} color={meta.color} />}
        <span className={styles.headerLabel} style={{ color: meta.color }}>
          {label}
        </span>
      </div>
      <div className={styles.log} ref={logRef}>
        {lines.length === 0 ? (
          <div className={styles.empty}>{emptyText}</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={styles.line} data-stream={line.stream}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
