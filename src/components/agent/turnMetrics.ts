/** Formatting shared by the activity card's live timer and the turn
 * footer, so a turn's elapsed time is written the same way in both. */

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return "<1s";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Compact token counts — a turn routinely reads tens of thousands of
 * cached tokens, and "42k" is the part anyone actually reads. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `null` when the CLI reported no cost for the run at all — Cursor Agent
 * never does, so a "$0.00" there would be a fabricated number rather than
 * a free turn. */
export function formatCost(totalCostUsd: number | null): string | null {
  if (totalCostUsd === null) return null;
  return totalCostUsd < 0.01 ? `<$0.01` : `$${totalCostUsd.toFixed(2)}`;
}

export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** How much of the model's window the last turn consumed, as a fraction.
 * Everything the model had to read counts — fresh input plus whatever came
 * back from cache — since that total is what fills the window and triggers
 * a compaction. `null` when the CLI reports no window (see
 * `capabilities.reportsContextWindow`), because a percentage of an unknown
 * denominator is just a made-up number. */
export function contextUsage(
  usage: TurnUsage,
  contextWindow: number | null,
): { used: number; window: number; percent: number } | null {
  if (!contextWindow || contextWindow <= 0) return null;
  const used =
    (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (used <= 0) return null;
  return {
    used,
    window: contextWindow,
    percent: Math.min(100, Math.round((used / contextWindow) * 100)),
  };
}

/** The one-line token summary, or `null` when this CLI reported no usage
 * for the turn (rather than showing a row of zeroes that reads as "this
 * turn was free"). */
export function usageSummary(usage: TurnUsage): string | null {
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`${formatTokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== null) parts.push(`${formatTokens(usage.outputTokens)} out`);
  const cached = usage.cacheReadTokens;
  if (cached !== null && cached > 0) parts.push(`${formatTokens(cached)} cached`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
