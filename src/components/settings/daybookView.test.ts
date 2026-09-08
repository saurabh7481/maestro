import { describe, expect, it } from "vitest";
import {
  nextDaybookStep,
  sourceStatusLabel,
  sourceTone,
  timelinePosition,
  visibleTimelineItems,
} from "./daybookView";

describe("Daybook setup helpers", () => {
  it("moves between real setup steps without escaping the sequence", () => {
    expect(nextDaybookStep("sources", -1)).toBe("sources");
    expect(nextDaybookStep("sources", 1)).toBe("writer");
    expect(nextDaybookStep("schedule", 1)).toBe("schedule");
  });

  it("maps source states to consistent labels and tones", () => {
    expect(sourceStatusLabel("pending")).toBe("Next step");
    expect(sourceStatusLabel("notConfigured")).toBe("Not connected");
    expect(sourceTone("ready")).toBe("ready");
    expect(sourceTone("pending")).toBe("warn");
    expect(sourceTone("disabled")).toBe("missing");
  });

  it("places valid local timestamps on the 24-hour strip", () => {
    const position = timelinePosition("2026-08-31T12:00:00");
    expect(position).toBe(50);
    expect(timelinePosition("not a date")).toBeNull();
    expect(
      visibleTimelineItems([
        { occurredAt: "not a date", id: "bad" },
        { occurredAt: "2026-08-31T18:00:00", id: "good" },
      ]),
    ).toEqual([{ occurredAt: "2026-08-31T18:00:00", id: "good", position: 75 }]);
  });
});
