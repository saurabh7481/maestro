import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { buildResponseBlocks, turnCompletion } from "./processingBlocks";

const completed: TranscriptItem = {
  id: "done",
  kind: "turnComplete",
  baselineHead: null,
  baselinePaths: [],
  durationMs: 4990,
  inputTokens: 4,
  outputTokens: 186,
  cacheReadTokens: 42014,
  cacheWriteTokens: 9869,
  completedAtMs: 1700000000000,
};

const thinking = (id: string): TranscriptItem => ({
  id,
  kind: "thinking",
  text: "reason",
  elapsedMs: null,
});
const tool = (id: string): TranscriptItem => ({
  id,
  kind: "toolCall",
  toolCallId: id,
  name: "Read",
  input: { path: "a.ts" },
});

describe("buildResponseBlocks", () => {
  it("collapses contiguous activity but preserves mid-turn assistant updates", () => {
    const blocks = buildResponseBlocks(
      [
        thinking("1"),
        tool("2"),
        { id: "3", kind: "assistantText", text: "I found the cause." },
        tool("4"),
      ],
      true,
    );

    expect(blocks.map((block) => block.kind)).toEqual(["process", "text", "process"]);
    expect(blocks[0].kind === "process" && blocks[0].items).toHaveLength(2);
    expect(blocks[2].kind === "process" && blocks[2].active).toBe(true);
  });

  it("adds a fresh active card after the latest assistant update", () => {
    const blocks = buildResponseBlocks(
      [thinking("1"), { id: "2", kind: "assistantText", text: "Still checking." }],
      true,
    );
    expect(blocks.map((block) => block.kind)).toEqual(["process", "text", "process"]);
    expect(blocks[2].kind === "process" && blocks[2].items).toHaveLength(0);
  });

  it("keeps the turn result out of the activity cards", () => {
    const blocks = buildResponseBlocks([tool("1"), completed], false);
    expect(blocks.map((block) => block.kind)).toEqual(["process"]);
    expect(blocks[0].kind === "process" && blocks[0].items).toHaveLength(1);
  });

  it("leaves a finished turn with no active card", () => {
    const blocks = buildResponseBlocks([tool("1"), completed], false);
    expect(blocks.every((block) => block.kind !== "process" || !block.active)).toBe(true);
  });
});

describe("turnCompletion", () => {
  // The regression this guards: usage used to be attached to the last
  // activity card, so a turn that just answered — no tools, no thinking —
  // reported no duration and no tokens at all.
  it("finds the result of a turn that used no tools", () => {
    const items: TranscriptItem[] = [
      { id: "1", kind: "assistantText", text: "The answer is 42." },
      completed,
    ];
    expect(buildResponseBlocks(items, false).map((block) => block.kind)).toEqual(["text"]);
    expect(turnCompletion(items)?.outputTokens).toBe(186);
  });

  it("is undefined while the turn is still running", () => {
    expect(turnCompletion([thinking("1"), tool("2")])).toBeUndefined();
  });
});
