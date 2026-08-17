import type { TranscriptItem } from "../../state/agentSessionStore";

export type ProcessItem = Extract<TranscriptItem, { kind: "thinking" | "toolCall" | "raw" }>;
export type TurnCompleteItem = Extract<TranscriptItem, { kind: "turnComplete" }>;

export type ToolCallItem = Extract<TranscriptItem, { kind: "toolCall" }>;

export type ResponseBlock =
  | { kind: "text"; item: Extract<TranscriptItem, { kind: "assistantText" }> }
  | { kind: "error"; item: Extract<TranscriptItem, { kind: "error" }> }
  /** The moment the agent finished planning and asked to start. Promoted
   * out of the activity card because it's a decision point, not a step. */
  | { kind: "plan"; item: ToolCallItem }
  | {
      kind: "process";
      key: string;
      items: ProcessItem[];
      active: boolean;
    };

/** Groups only contiguous implementation activity. Assistant narration is
 * deliberately a boundary, producing the requested rhythm:
 * Processing → assistant update → Processing → final answer. */
export function buildResponseBlocks(
  items: TranscriptItem[],
  working: boolean,
  /** `capabilities.planExitTool` — the tool name that means "plan ready"
   * for this provider, or `null`/undefined where it has none. */
  planExitTool?: string | null,
): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];

  for (const item of items) {
    if (planExitTool && item.kind === "toolCall" && item.name === planExitTool) {
      blocks.push({ kind: "plan", item });
      continue;
    }
    // The turn's result is rendered as a footer under the whole response
    // (see `turnCompletion`), not folded into an activity card.
    if (item.kind === "turnComplete") continue;
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
      });
    }
  }

  if (working) {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "process") last.active = true;
    // Text still being typed out is its own progress indicator (the
    // caret). Stacking a shimmering "Working" card under it would say the
    // same thing twice, and louder.
    else if (last?.kind === "text" && last.item.streaming) {
      // nothing to add
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

/** The turn's own result, for the footer under a finished response.
 * Deliberately separate from the blocks above: a turn that answered in
 * plain prose has no process block to hang it off, and hiding the time and
 * token cost of exactly the cheapest turns was the old behaviour's blind
 * spot. `undefined` while the turn is still running. */
export function turnCompletion(items: TranscriptItem[]): TurnCompleteItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "turnComplete") return item;
  }
  return undefined;
}
