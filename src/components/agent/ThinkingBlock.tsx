import { memo, useState } from "react";
import { Brain, CaretDown } from "@phosphor-icons/react";
import { formatDuration } from "./turnMetrics";
import styles from "./ThinkingBlock.module.css";

/** Collapsed-by-default "Thought for …" chip.
 *
 * No CLI reports how long a thinking block took, so `elapsedMs` is
 * measured on arrival by `agentSessionStore` — see its comment on the
 * `thinking` item for exactly what it does and doesn't include. Anything
 * under a second is dropped rather than shown as "<1s", since at that
 * scale the measurement is mostly latency.
 *
 * `memo`'d for the same reason as its siblings in the transcript — a
 * streamed event must not re-render every earlier block, and collapsing
 * one of these must not disturb the rest (docs/PERFORMANCE_AUDIT.md §1.3). */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  elapsedMs = null,
  nested = false,
}: {
  text: string;
  elapsedMs?: number | null;
  nested?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-nested={nested || undefined}>
      <button
        type="button"
        className={styles.chip}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Brain size={14} color="var(--purple)" />
        {elapsedMs !== null && elapsedMs >= 1000
          ? `Thought for ${formatDuration(elapsedMs)}`
          : "Thinking"}
        <CaretDown
          size={11}
          style={{
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform var(--duration-fast, 120ms)",
          }}
        />
      </button>
      {expanded && <div className={styles.text}>{text}</div>}
    </div>
  );
});
