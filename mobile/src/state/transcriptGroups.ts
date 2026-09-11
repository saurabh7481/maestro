import type { TranscriptItem } from "./transcript";

/** Ported (trimmed) from the desktop's `src/components/agent/AgentTab.tsx`
 * (`groupItems`) and `processingBlocks.ts` (`buildResponseBlocks`,
 * `turnCompletion`) — same grouping so mobile's transcript reads exactly
 * like the desktop's: user turns as bubbles, everything else in an
 * assistant turn as one collapsible "Working"/"Worked" processing card per
 * contiguous run, with prose as its own boundary. Plan/Questions
 * artifact promotion is intentionally not ported (a v1 scope cut — those
 * render as ordinary tool-call cards here instead of a dedicated card). */

export type Group =
  | { role: "user"; text: string; key: string }
  | { role: "assistant"; items: TranscriptItem[]; key: string };

export function groupItems(items: TranscriptItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ role: "user", text: item.text, key: item.id });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.role === "assistant") last.items.push(item);
    else groups.push({ role: "assistant", items: [item], key: item.id });
  }
  return groups;
}

export type ProcessItem = Extract<
  TranscriptItem,
  { kind: "thinking" | "toolCall" | "raw" | "status" }
>;
export type TurnCompleteItem = Extract<TranscriptItem, { kind: "turnComplete" }>;

export type ResponseBlock =
  | { kind: "text"; item: Extract<TranscriptItem, { kind: "assistantText" }> }
  | { kind: "error"; item: Extract<TranscriptItem, { kind: "error" }> }
  | { kind: "process"; key: string; items: ProcessItem[]; active: boolean };

export function buildResponseBlocks(items: TranscriptItem[], working: boolean): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];

  for (const item of items) {
    if (item.kind === "turnComplete") continue;
    if (item.kind === "assistantText") {
      blocks.push({ kind: "text", item });
      continue;
    }
    if (item.kind === "error") {
      blocks.push({ kind: "error", item });
      continue;
    }
    if (item.kind === "user") continue;

    const previous = blocks[blocks.length - 1];
    if (previous?.kind === "process") previous.items.push(item);
    else blocks.push({ kind: "process", key: item.id, items: [item], active: false });
  }

  if (working) {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "process") last.active = true;
    else if (last?.kind === "text" && last.item.streaming) {
      // Text still being typed is its own progress indicator.
    } else {
      blocks.push({
        kind: "process",
        key: `active-${items[items.length - 1]?.id ?? "empty"}`,
        items: [],
        active: true,
      });
    }
  }

  return blocks;
}

export function turnCompletion(items: TranscriptItem[]): TurnCompleteItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "turnComplete") return item;
  }
  return undefined;
}
