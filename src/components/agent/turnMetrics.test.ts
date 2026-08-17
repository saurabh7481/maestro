import { describe, expect, it } from "vitest";
import {
  contextUsage,
  formatCost,
  formatDuration,
  formatTokens,
  usageSummary,
} from "./turnMetrics";

describe("formatDuration", () => {
  it("never rounds a real turn down to 0s", () => {
    expect(formatDuration(120)).toBe("<1s");
    expect(formatDuration(4990)).toBe("5s");
  });

  it("switches to minutes past the minute mark", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});

describe("formatTokens", () => {
  it("keeps small counts exact and compacts large ones", () => {
    expect(formatTokens(186)).toBe("186");
    expect(formatTokens(9869)).toBe("9.9k");
    expect(formatTokens(42014)).toBe("42k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("formatCost", () => {
  it("reports no cost rather than a fabricated $0.00", () => {
    // Cursor Agent never reports cost — "$0.00" would read as "this was
    // free" instead of "this CLI doesn't say".
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0.0001)).toBe("<$0.01");
    expect(formatCost(0.0746202)).toBe("$0.07");
  });
});

describe("contextUsage", () => {
  const usage = {
    inputTokens: 2,
    outputTokens: 20,
    cacheReadTokens: 8025,
    cacheWriteTokens: 8399,
  };

  it("counts everything the model had to read, not just fresh input", () => {
    // Cache reads still occupy the window; ignoring them would report a
    // near-empty context right up until a surprise compaction.
    const result = contextUsage(usage, 1_000_000);
    expect(result).toEqual({ used: 16426, window: 1_000_000, percent: 2 });
  });

  it("is null when the CLI reports no window", () => {
    // A percentage of an unknown denominator would be invented.
    expect(contextUsage(usage, null)).toBeNull();
    expect(contextUsage(usage, 0)).toBeNull();
  });

  it("is null before anything has been used", () => {
    expect(
      contextUsage(
        { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
        1_000_000,
      ),
    ).toBeNull();
  });

  it("never reports more than a full window", () => {
    expect(contextUsage({ ...usage, inputTokens: 5_000_000 }, 1_000_000)?.percent).toBe(100);
  });
});

describe("usageSummary", () => {
  it("summarises a turn's tokens", () => {
    expect(
      usageSummary({
        inputTokens: 4,
        outputTokens: 186,
        cacheReadTokens: 42014,
        cacheWriteTokens: 9869,
      }),
    ).toBe("4 in · 186 out · 42k cached");
  });

  it("omits a cache read of zero instead of printing a noisy 0", () => {
    expect(
      usageSummary({
        inputTokens: 14737,
        outputTokens: 34,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe("15k in · 34 out");
  });

  it("is null when the CLI reported nothing", () => {
    expect(
      usageSummary({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ).toBeNull();
  });
});
