import type { TranscriptItem } from "../../state/agentSessionStore";

export type ProcessItem = Extract<TranscriptItem, { kind: "thinking" | "toolCall" | "raw" }>;
export type TurnCompleteItem = Extract<TranscriptItem, { kind: "turnComplete" }>;

export type ResponseBlock =
  | { kind: "text"; item: Extract<TranscriptItem, { kind: "assistantText" }> }
  | { kind: "error"; item: Extract<TranscriptItem, { kind: "error" }> }
  | {
      kind: "process";
      key: string;
      items: ProcessItem[];
      active: boolean;
      completion: TurnCompleteItem | null;
    };

/** Groups only contiguous implementation activity. Assistant narration is
 * deliberately a boundary, producing the requested rhythm:
 * Processing → assistant update → Processing → final answer. */
export function buildResponseBlocks(items: TranscriptItem[], working: boolean): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];
  let completion: TurnCompleteItem | null = null;

  for (const item of items) {
    if (item.kind === "turnComplete") {
      completion = item;
      continue;
    }
    if (item.kind === "assistantText") {
      blocks.push({ kind: "text", item });
      continue;
    }
    if (item.kind === "error") {
      blocks.push({ kind: "error", item });
      continue;
    }
    // Assistant groups are built after user items split the transcript,
    // but keep this utility total for direct callers and malformed input.
    if (item.kind === "user") continue;

    const previous = blocks[blocks.length - 1];
    if (previous?.kind === "process") previous.items.push(item);
    else {
      blocks.push({
        kind: "process",
        key: item.id,
        items: [item],
        active: false,
        completion: null,
      });
    }
  }

  if (working) {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "process") last.active = true;
    else {
      blocks.push({
        kind: "process",
        key: `active-${items[items.length - 1]?.id ?? "empty"}`,
        items: [],
        active: true,
        completion: null,
      });
    }
  } else if (completion) {
    const lastProcess = [...blocks].reverse().find((block) => block.kind === "process");
    if (lastProcess?.kind === "process") lastProcess.completion = completion;
  }

  return blocks;
}
