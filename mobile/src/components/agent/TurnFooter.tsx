import { Clock, Coins } from "@phosphor-icons/react";
import type { TurnCompleteItem } from "../../state/transcriptGroups";
import { formatCost, formatDuration, usageSummary } from "../../design/turnMetrics";

/** Ported from the desktop's `TurnFooter.tsx` — the quiet one-line receipt
 * under a finished response: duration, tokens, session cost. */
export function TurnFooter({
  completion,
  totalCostUsd,
}: {
  completion: TurnCompleteItem;
  totalCostUsd: number | null;
}) {
  const usage = usageSummary(completion);
  const cost = formatCost(totalCostUsd);
  const duration = completion.durationMs > 0 ? formatDuration(completion.durationMs) : null;

  if (!usage && !cost && !duration) return null;

  return (
    <div className="turn-footer">
      {duration && (
        <span className="turn-footer-metric">
          <Clock size={11} />
          {duration}
        </span>
      )}
      {usage && <span className="turn-footer-metric">{usage}</span>}
      {cost && (
        <span className="turn-footer-metric">
          <Coins size={11} />
          {cost} session
        </span>
      )}
    </div>
  );
}
