import type { TranscriptItem } from "../../state/agentSessionStore";
import { looksLikeQuestions } from "./questionArtifact";

export type ProcessItem = Extract<
  TranscriptItem,
  { kind: "thinking" | "toolCall" | "raw" | "status" }
>;
export type TurnCompleteItem = Extract<TranscriptItem, { kind: "turnComplete" }>;

export type ToolCallItem = Extract<TranscriptItem, { kind: "toolCall" }>;

/** Cursor builds before Maestro learned `createPlanToolCall` persisted the
 * artifact as a generic `Tool`. Recognize its unambiguous payload too so
 * existing conversations are repaired on sight instead of only future
 * turns working after an app restart. */
function isPlanArtifact(item: ToolCallItem, planExitTool?: string | null): boolean {
  if (planExitTool && item.name === planExitTool) return true;
  if (item.name !== "Tool" || !item.input || typeof item.input !== "object") return false;
  const input = item.input as Record<string, unknown>;
  return (
    typeof input.plan === "string" &&
    (typeof input.name === "string" ||
      typeof input.overview === "string" ||
      Array.isArray(input.todos))
  );
}

/** Cursor Agent's question form. The tool name is enough for anything
 * parsed by a build that knows `askQuestionToolCall`; the payload sniff
 * covers transcripts recorded before that, which stored it as a generic
 * `Tool` (see `isPlanArtifact`, which makes the same allowance). */
function isQuestionArtifact(item: ToolCallItem): boolean {
  if (item.name === "AskQuestion") return true;
  return item.name === "Tool" && looksLikeQuestions(item.input);
}

/** Raw markdown for one complete assistant turn. Providers may split their
 * narration around thinking/tool events, but copying the response should
 * produce one coherent payload rather than one clipboard button per split. */
export function assistantResponseMarkdown(items: TranscriptItem[]): string {
  return items
    .filter(
      (item): item is Extract<TranscriptItem, { kind: "assistantText" }> =>
        item.kind === "assistantText" && item.text.length > 0,
    )
    .map((item) => item.text)
    .join("\n\n");
}

export type ResponseBlock =
  | { kind: "text"; item: Extract<TranscriptItem, { kind: "assistantText" }> }
  | { kind: "error"; item: Extract<TranscriptItem, { kind: "error" }> }
  /** The moment the agent finished planning and asked to start. Promoted
   * out of the activity card because it's a decision point, not a step. */
  | { kind: "plan"; item: ToolCallItem }
  /** Questions the agent asked and the CLI auto-skipped. Promoted for the
   * same reason: the turn moved on, but the user is the only one who can
   * answer them. */
  | { kind: "questions"; item: ToolCallItem }
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
    if (item.kind === "toolCall" && isPlanArtifact(item, planExitTool)) {
      blocks.push({ kind: "plan", item });
      continue;
    }
    if (item.kind === "toolCall" && isQuestionArtifact(item)) {
      blocks.push({ kind: "questions", item });
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
