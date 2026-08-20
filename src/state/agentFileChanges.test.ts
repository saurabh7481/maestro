import { describe, expect, it, vi } from "vitest";
import { computeTurnFileChanges } from "./agentFileChanges";
import type { TranscriptItem } from "./agentSessionStore";

const gitApi = vi.hoisted(() => ({
  getWorkingStatus: vi.fn(),
  getCommitLog: vi.fn(),
  getCommitFiles: vi.fn(),
}));
vi.mock("../api/git", () => ({ gitApi }));

const ROOT = "/repo";

function toolCall(input: unknown, overrides: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    id: "t1",
    kind: "toolCall",
    toolCallId: "tc1",
    name: "Write",
    input,
    result: { content: "", isError: false, diffAdded: 3, diffRemoved: 1 },
    ...overrides,
  } as TranscriptItem;
}

function turnComplete(baselineHead: string | null, baselinePaths: string[] = []): TranscriptItem {
  return {
    id: "done",
    kind: "turnComplete",
    baselineHead,
    baselinePaths,
    durationMs: 100,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    completedAtMs: 1700000000000,
  };
}

describe("computeTurnFileChanges", () => {
  it("infers a changed path from a tool call's input", async () => {
    gitApi.getWorkingStatus.mockResolvedValue({
      entries: [{ path: "src/foo.ts", unstaged: { kind: "modified" } }],
    });
    gitApi.getCommitLog.mockResolvedValue([{ hash: "abc123" }]);

    const items = [toolCall({ file_path: "src/foo.ts" }), turnComplete("abc123")];
    const files = await computeTurnFileChanges(ROOT, items);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "src/foo.ts", mode: "unstaged", added: 3, removed: 1 });
  });

  it("unions in a live-dirty path no tool call reported", async () => {
    gitApi.getWorkingStatus.mockResolvedValue({
      entries: [{ path: "src/untouched-by-tools.ts", unstaged: { kind: "modified" } }],
    });
    gitApi.getCommitLog.mockResolvedValue([{ hash: "abc123" }]);

    const items = [turnComplete("abc123", [])];
    const files = await computeTurnFileChanges(ROOT, items);

    expect(files.map((f) => f.path)).toEqual(["src/untouched-by-tools.ts"]);
  });

  it("excludes a path that was already dirty before the turn started (baselinePaths)", async () => {
    gitApi.getWorkingStatus.mockResolvedValue({
      entries: [{ path: "src/already-dirty.ts", unstaged: { kind: "modified" } }],
    });
    gitApi.getCommitLog.mockResolvedValue([{ hash: "abc123" }]);

    const items = [turnComplete("abc123", ["src/already-dirty.ts"])];
    const files = await computeTurnFileChanges(ROOT, items);

    expect(files).toHaveLength(0);
  });

  it("pulls in a commit's files when the turn advanced HEAD", async () => {
    gitApi.getWorkingStatus.mockResolvedValue({ entries: [] });
    gitApi.getCommitLog.mockResolvedValue([{ hash: "new-head" }]);
    gitApi.getCommitFiles.mockResolvedValue([["src/committed.ts", { kind: "modified" }]]);

    const items = [turnComplete("old-head", [])];
    const files = await computeTurnFileChanges(ROOT, items);

    expect(gitApi.getCommitFiles).toHaveBeenCalledWith(ROOT, "new-head");
    expect(files).toEqual([
      expect.objectContaining({ path: "src/committed.ts", mode: "commit", commitHash: "new-head" }),
    ]);
  });
});
