import { memo, useState } from "react";
import { Brain, CaretDown } from "@phosphor-icons/react";
import styles from "./ThinkingBlock.module.css";

/** Collapsed-by-default "Thought for …" chip, matching the design file's
 * agent-chat markup. There's no real elapsed-time field on the wire
 * (the `thinking` content block carries text only), so this shows a
 * generic label rather than fabricating a duration.
 *
 * `memo`'d for the same reason as its siblings in the transcript — a
 * streamed event must not re-render every earlier block, and collapsing
 * one of these must not disturb the rest (docs/PERFORMANCE_AUDIT.md §1.3). */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  nested = false,
}: {
  text: string;
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
        Thinking
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
