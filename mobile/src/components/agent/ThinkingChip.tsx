import { useState } from "react";
import { Brain, CaretDown } from "@phosphor-icons/react";
import { formatDuration } from "../../design/turnMetrics";

/** Ported from the desktop's `ThinkingBlock.tsx` — collapsed-by-default
 * "Thought for …" chip. */
export function ThinkingChip({
  text,
  elapsedMs = null,
}: {
  text: string;
  elapsedMs?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="thinking-chip"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Brain size={14} color="var(--purple)" />
        {elapsedMs !== null && elapsedMs >= 1000
          ? `Thought for ${formatDuration(elapsedMs)}`
          : "Thinking"}
        <CaretDown size={11} style={{ transform: expanded ? "rotate(180deg)" : "none" }} />
      </button>
      {expanded && <div className="thinking-chip-text">{text}</div>}
    </div>
  );
}
