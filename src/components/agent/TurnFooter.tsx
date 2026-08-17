import { memo } from "react";
import { Clock, Coins } from "@phosphor-icons/react";
import type { TurnCompleteItem } from "./processingBlocks";
import { formatCost, formatDuration, usageSummary } from "./turnMetrics";
import styles from "./TurnFooter.module.css";

/** The quiet one-line receipt under a finished response: how long the turn
 * took and what it spent. Lives at the end of the whole assistant group
 * rather than inside an activity card, so a turn that answered in plain
 * prose — no tools, no thinking — still reports its cost instead of
 * silently being the one kind of turn with no numbers at all. */
export const TurnFooter = memo(function TurnFooter({
  completion,
  totalCostUsd,
}: {
  completion: TurnCompleteItem;
  /** Session-cumulative for Claude Code, so it's labelled as a running
   * total rather than passed off as this turn's price. `null` for CLIs
   * that don't report cost. */
  totalCostUsd: number | null;
}) {
  const usage = usageSummary(completion);
  const cost = formatCost(totalCostUsd);
  const duration = completion.durationMs > 0 ? formatDuration(completion.durationMs) : null;

  if (!usage && !cost && !duration) return null;

  return (
    <div className={styles.footer}>
      {duration && (
        <span className={styles.metric}>
          <Clock size={11} />
          {duration}
        </span>
      )}
      {usage && <span className={styles.metric}>{usage}</span>}
      {cost && (
        <span className={styles.metric} title="Session total reported by the CLI">
          <Coins size={11} />
          {cost} session
        </span>
      )}
    </div>
  );
});
