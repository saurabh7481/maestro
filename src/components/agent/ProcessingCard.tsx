import { memo, useEffect, useId, useMemo, useState } from "react";
import { Brain, CaretDown, Wrench } from "@phosphor-icons/react";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { formatDuration } from "./turnMetrics";
import type { ProcessItem } from "./processingBlocks";
import styles from "./ProcessingCard.module.css";

const RawDetail = memo(function RawDetail({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "raw" }>;
}) {
  return (
    <details className={styles.rawDetail}>
      <summary>
        <Wrench size={13} /> Unrecognized event
      </summary>
      <pre>{JSON.stringify(item.json, null, 2)}</pre>
    </details>
  );
});

/** The single collapsed card that stands in for a run of the agent's
 * under-the-hood work — thinking, tool calls, unrecognized events — so a
 * response reads as prose punctuated by activity rather than a wall of
 * one card per step. Expanding it reveals every step, unedited, inside a
 * fixed-height scroller. */
export const ProcessingCard = memo(function ProcessingCard({
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
  const detailsId = useId();

  useEffect(() => {
    if (requiresPermission) setExpanded(true);
  }, [requiresPermission]);

  useEffect(() => {
    if (!active || !turnStartedAtMs) return;
    // Re-sync immediately as well as on the interval: a card that becomes
    // active later would otherwise carry a `now` frozen at mount time.
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, turnStartedAtMs]);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const label =
        item.kind === "thinking" ? "Thinking" : item.kind === "raw" ? "Event" : item.name;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => (count > 1 ? `${count} ${label}` : label))
      .slice(0, 3)
      .join(" · ");
  }, [items]);

  // Only the running card has a live elapsed time to show. A settled one
  // used to render `now - turnStartedAtMs` off a `now` its own timer had
  // stopped updating, i.e. a number that was simply wrong; the turn's real
  // duration belongs to the footer under the whole response.
  const elapsedMs = active && turnStartedAtMs ? now - turnStartedAtMs : 0;
  const stepCount = items.length;

  return (
    <section
      className={styles.card}
      data-active={active || undefined}
      data-permission={requiresPermission || undefined}
    >
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        <span className={styles.activityIcon}>
          <Brain size={14} />
        </span>
        <span className={styles.title}>
          {requiresPermission ? "Permission required" : active ? "Working" : "Worked"}
        </span>
        <span className={styles.summary}>{summary || "Preparing next step"}</span>
        <span className={styles.metrics}>
          {elapsedMs > 0 && <span>{formatDuration(elapsedMs)}</span>}
          {!active && stepCount > 0 && (
            <span>
              {stepCount} {stepCount === 1 ? "step" : "steps"}
            </span>
          )}
        </span>
        <CaretDown className={styles.caret} size={12} data-expanded={expanded || undefined} />
      </button>
      {expanded && (
        <div
          id={detailsId}
          className={styles.details}
          role="region"
          aria-label="Processing details"
        >
          {items.length === 0 && (
            <div className={styles.preparing}>Waiting for agent activity…</div>
          )}
          {items.map((item) => {
            if (item.kind === "thinking")
              return (
                <ThinkingBlock key={item.id} text={item.text} elapsedMs={item.elapsedMs} nested />
              );
            if (item.kind === "toolCall")
              return (
                <ToolCallCard key={item.id} runId={runId} item={item} nested running={active} />
              );
            return <RawDetail key={item.id} item={item} />;
          })}
        </div>
      )}
    </section>
  );
});
