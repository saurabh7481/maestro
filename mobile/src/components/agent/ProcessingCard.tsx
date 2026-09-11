import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Brain, CaretDown, Wrench } from "@phosphor-icons/react";
import type { TranscriptItem } from "../../state/transcript";
import type { ProcessItem } from "../../state/transcriptGroups";
import { formatDuration } from "../../design/turnMetrics";
import { ThinkingChip } from "./ThinkingChip";
import { MobileToolCallCard } from "./MobileToolCallCard";

/** Ported from the desktop's `ProcessingCard.tsx` — the single collapsed
 * card standing in for a run of the agent's under-the-hood work (thinking,
 * tool calls, unrecognized events), so a response reads as prose punctuated
 * by activity rather than a wall of one card per step. */
export function ProcessingCard({
  runId,
  items,
  active,
  turnStartedAtMs,
}: {
  runId: string;
  items: ProcessItem[];
  active: boolean;
  turnStartedAtMs: number | null;
}) {
  const requiresPermission = items.some(
    (item) => item.kind === "toolCall" && item.permission?.status === "pending",
  );
  const [expanded, setExpanded] = useState(requiresPermission);
  const [now, setNow] = useState(() => Date.now());

  // Adjusting state during render (React's documented pattern for "state
  // that must reset when a prop changes", also used by the desktop's own
  // `AgentTab.tsx::useStableGroups`) rather than in an effect — refs can't
  // be read during render under this app's React Compiler lint config, so
  // the "previous value" itself has to live in state, not a ref.
  const [trackedRequiresPermission, setTrackedRequiresPermission] = useState(requiresPermission);
  if (requiresPermission !== trackedRequiresPermission) {
    setTrackedRequiresPermission(requiresPermission);
    if (requiresPermission) setExpanded(true);
  }

  useEffect(() => {
    if (!active || !turnStartedAtMs) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, turnStartedAtMs]);

  const summary = useMemo(() => {
    if (items[items.length - 1]?.kind === "status") {
      return (items[items.length - 1] as Extract<TranscriptItem, { kind: "status" }>).text;
    }
    const counts = new Map<string, number>();
    for (const item of items) {
      const label =
        item.kind === "thinking"
          ? "Thinking"
          : item.kind === "raw"
            ? "Event"
            : item.kind === "status"
              ? "Status"
              : item.name;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => (count > 1 ? `${count} ${label}` : label))
      .slice(0, 3)
      .join(" · ");
  }, [items]);

  const elapsedMs = active && turnStartedAtMs ? now - turnStartedAtMs : 0;
  const stepCount = items.length;

  return (
    <section
      className="processing-card"
      data-active={active || undefined}
      data-permission={requiresPermission || undefined}
    >
      <button
        type="button"
        className="processing-card-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="processing-card-icon">
          <Brain size={14} />
        </span>
        <span className="processing-card-title">
          {requiresPermission ? "Permission required" : active ? "Working" : "Worked"}
        </span>
        <span className="processing-card-summary">{summary || "Preparing next step"}</span>
        <span className="processing-card-metrics">
          {elapsedMs > 0 && <span>{formatDuration(elapsedMs)}</span>}
          {!active && stepCount > 0 && (
            <span>
              {stepCount} {stepCount === 1 ? "step" : "steps"}
            </span>
          )}
        </span>
        <CaretDown size={12} style={{ transform: expanded ? "rotate(180deg)" : "none" }} />
      </button>
      {expanded && (
        <div className="processing-card-details">
          {items.length === 0 && (
            <div className="processing-card-preparing">Waiting for agent activity…</div>
          )}
          {items.map((item) => {
            if (item.kind === "thinking")
              return <ThinkingChip key={item.id} text={item.text} elapsedMs={item.elapsedMs} />;
            if (item.kind === "toolCall")
              return (
                <MobileToolCallCard
                  key={item.id}
                  runId={runId}
                  item={item}
                  nested
                  running={active}
                />
              );
            if (item.kind === "status")
              return (
                <div className="status-row" key={item.id}>
                  <ArrowClockwise size={13} />
                  <span>{item.text}</span>
                </div>
              );
            return (
              <details className="raw-detail" key={item.id}>
                <summary>
                  <Wrench size={13} /> Unrecognized event
                </summary>
                <pre>{JSON.stringify(item.json, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
