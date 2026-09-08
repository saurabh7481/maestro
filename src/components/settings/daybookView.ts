import type { DaybookPreviewItem, DaybookSourceStatus } from "../../types/daybook";

export const DAYBOOK_STEPS = ["sources", "writer", "destination", "schedule"] as const;
export type DaybookStep = (typeof DAYBOOK_STEPS)[number];

export const DAYBOOK_STEP_LABEL: Record<DaybookStep, string> = {
  sources: "Sources",
  writer: "Writer",
  destination: "Destination",
  schedule: "Schedule",
};

export function nextDaybookStep(step: DaybookStep, direction: -1 | 1): DaybookStep {
  const index = DAYBOOK_STEPS.indexOf(step);
  const next = Math.max(0, Math.min(DAYBOOK_STEPS.length - 1, index + direction));
  return DAYBOOK_STEPS[next];
}

export function sourceTone(status: DaybookSourceStatus): "ready" | "warn" | "missing" {
  if (status === "ready") return "ready";
  if (status === "pending") return "warn";
  return "missing";
}

export function sourceStatusLabel(status: DaybookSourceStatus): string {
  switch (status) {
    case "ready":
      return "Included";
    case "pending":
      return "Next step";
    case "notConfigured":
      return "Not connected";
    case "unavailable":
      return "Unavailable";
    case "disabled":
      return "Excluded";
  }
}

export function timelinePosition(occurredAt: string): number | null {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return (minutes / (24 * 60)) * 100;
}

export function visibleTimelineItems<T extends Pick<DaybookPreviewItem, "occurredAt">>(
  items: T[],
): Array<T & { position: number }> {
  return items.flatMap((item) => {
    const position = timelinePosition(item.occurredAt);
    return position == null ? [] : [{ ...item, position }];
  });
}
