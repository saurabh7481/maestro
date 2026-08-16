import { memo, useEffect, useMemo, useState } from "react";
import { Brain, CaretDown, Wrench } from "@phosphor-icons/react";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import type { ProcessItem, TurnCompleteItem } from "./processingBlocks";
import styles from "./ProcessingCard.module.css";

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${Math.max(1, Math.round(durationMs / 1000))}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function usageLabel(completion: TurnCompleteItem | null): string | null {
  if (!completion) return null;
  const parts: string[] = [];
  if (completion.inputTokens !== null) parts.push(`${compactNumber(completion.inputTokens)} in`);
  if (completion.outputTokens !== null) parts.push(`${compactNumber(completion.outputTokens)} out`);
  if (completion.cacheReadTokens !== null && completion.cacheReadTokens > 0) {
    parts.push(`${compactNumber(completion.cacheReadTokens)} cached`);
  }
  return parts.length ? parts.join(" · ") : null;
}

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

export const ProcessingCard = memo(function ProcessingCard({
  runId,
  items,
  active,
  completion,
  turnStartedAtMs,
}: {
  runId: string;
  items: ProcessItem[];
  active: boolean;
  completion: TurnCompleteItem | null;
  turnStartedAtMs: number | null;
}) {
  const requiresPermission = items.some(
    (item) => item.kind === "toolCall" && item.permission?.status === "pending",
  );
  const [expanded, setExpanded] = useState(requiresPermission);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (requiresPermission) setExpanded(true);
  }, [requiresPermission]);

  useEffect(() => {
    if (!active || !turnStartedAtMs) return;
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

  const durationMs = completion?.durationMs ?? (turnStartedAtMs ? now - turnStartedAtMs : 0);
  const usage = usageLabel(completion);
  const detailsId = `processing-${items[0]?.id ?? "active"}`;

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
          {requiresPermission ? "Permission required" : active ? "Processing" : "Processed"}
        </span>
        <span className={styles.summary}>{summary || "Preparing next step"}</span>
        <span className={styles.metrics}>
          {durationMs > 0 && <span>{formatDuration(durationMs)}</span>}
          {usage && <span>{usage}</span>}
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
              return <ThinkingBlock key={item.id} text={item.text} nested />;
            if (item.kind === "toolCall")
              return <ToolCallCard key={item.id} runId={runId} item={item} nested />;
            return <RawDetail key={item.id} item={item} />;
          })}
        </div>
      )}
    </section>
  );
});
