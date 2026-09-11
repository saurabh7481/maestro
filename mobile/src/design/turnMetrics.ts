/** Ported from the desktop's `src/components/agent/turnMetrics.ts` —
 * shared formatting for the activity card's live timer and the turn
 * footer, so a turn's elapsed time/cost/tokens read identically on both
 * surfaces. */

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return "<1s";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

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

export function usageSummary(usage: TurnUsage): string | null {
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`${formatTokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== null) parts.push(`${formatTokens(usage.outputTokens)} out`);
  const cached = usage.cacheReadTokens;
  if (cached !== null && cached > 0) parts.push(`${formatTokens(cached)} cached`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
