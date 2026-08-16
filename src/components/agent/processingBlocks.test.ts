import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { buildResponseBlocks } from "./processingBlocks";

const thinking = (id: string): TranscriptItem => ({ id, kind: "thinking", text: "reason" });
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
});
