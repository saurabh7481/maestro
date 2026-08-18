import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionStore } from "./agentSessionStore";
import type { AgentEvent } from "../types/agent";

// The store subscribes to Tauri events via `openRun`; these tests drive
// `applyEvent` directly instead, which is the same entry point that
// listener calls, so no Tauri bridge is needed.
vi.mock("../api/agentEvents", () => ({
  listenToAgentEvents: () => Promise.resolve(() => {}),
}));

// `vi.hoisted` because `vi.mock`'s factory is lifted above the module's
// own statements — a plain `const` declared here would not exist yet when
// the factory runs.
const api = vi.hoisted(() => ({
  loadAgentTranscript: vi.fn(),
  saveAgentTranscript: vi.fn(() => Promise.resolve()),
  deleteAgentTranscript: vi.fn(() => Promise.resolve()),
  resumeAgentSession: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api/agents", () => ({ agentsApi: api }));

const RUN = "run-1";

function apply(...events: AgentEvent[]) {
  for (const event of events) useAgentSessionStore.getState().applyEvent(RUN, event);
}

function state() {
  const tab = useAgentSessionStore.getState().byRunId[RUN];
  if (!tab) throw new Error("expected the run to exist");
  return tab;
}

const toolCall: AgentEvent = {
  type: "toolCall",
  id: "toolu_1",
  name: "Write",
  input: { file_path: "a.txt" },
};

const denied: AgentEvent = {
  type: "permissionDenied",
  toolName: "Write",
  toolUseId: "toolu_1",
  toolInput: { file_path: "a.txt" },
  message: "Claude requested permission to write a.txt",
  gated: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears recorded calls but leaves a queued
  // `mockResolvedValueOnce` in place, so an unconsumed one would leak into
  // the next test and answer *its* load instead.
  api.loadAgentTranscript.mockReset();
  useAgentSessionStore.setState({
    byRunId: {},
    unlistenByRunId: {},
    editingByRunId: {},
    draftByRunId: {},
  });
  useAgentSessionStore.getState().appendUserMessage(RUN, "write a.txt");
});

describe("permission pause lifecycle", () => {
  it("parks the run on awaitingPermission instead of leaving it working", () => {
    apply(toolCall, denied);
    // The denial alone doesn't end the turn — the CLI is still winding down.
    expect(state().status).toBe("working");

    apply({ type: "awaitingPermission", toolUseId: "toolu_1" });
    expect(state().status).toBe("awaitingPermission");
    expect(state().turnStartedAtMs).toBeNull();
  });

  it("does not report the paused turn's exit as a crash", () => {
    apply(
      toolCall,
      denied,
      { type: "awaitingPermission", toolUseId: "toolu_1" },
      {
        type: "exit",
        code: 0,
      },
    );

    // Regression guard: `exit` while `working` means the process died
    // mid-turn, but a deliberate pause must not be dressed up as one.
    expect(state().status).toBe("awaitingPermission");
    expect(state().errorMessage).toBeNull();
  });

  it("still reports a genuine mid-turn crash", () => {
    apply(toolCall, { type: "exit", code: 1 });
    expect(state().status).toBe("error");
    expect(state().errorMessage).toContain("exited unexpectedly");
  });

  it("marks the tool call pending so the card can offer Approve/Deny", () => {
    apply(toolCall, denied);
    const item = state().items.find((entry) => entry.kind === "toolCall");
    expect(item?.kind === "toolCall" && item.permission).toEqual({
      status: "pending",
      message: "Claude requested permission to write a.txt",
    });
  });

  // Outside `manual` mode the CLI refuses on its own and carries straight
  // on. Offering Approve/Deny there asks a question no one is waiting for
  // — the reported "it asks for permission but continues anyway".
  it("records an ungated refusal as blocked rather than a question", () => {
    apply(toolCall, { ...denied, gated: false });
    const item = state().items.find((entry) => entry.kind === "toolCall");
    expect(item?.kind === "toolCall" && item.permission).toEqual({
      status: "blocked",
      message: "Claude requested permission to write a.txt",
    });
  });
});

describe("streaming text", () => {
  const delta = (text: string): AgentEvent => ({ type: "messageDelta", text });

  function assistantText() {
    return state().items.filter((item) => item.kind === "assistantText");
  }

  it("accumulates deltas into one growing item", () => {
    apply(delta("The "), delta("quick "), delta("brown fox"));
    const texts = assistantText();
    expect(texts).toHaveLength(1);
    expect(texts[0].kind === "assistantText" && texts[0].text).toBe("The quick brown fox");
    expect(texts[0].kind === "assistantText" && texts[0].streaming).toBe(true);
  });

  it("lets the finished block replace the stream instead of duplicating it", () => {
    // Claude sends deltas *and* the consolidated message. Appending the
    // second would show the whole reply twice.
    apply(delta("The quick "), delta("brown"));
    apply({ type: "message", role: "assistant", text: "The quick brown fox." });

    const texts = assistantText();
    expect(texts).toHaveLength(1);
    expect(texts[0].kind === "assistantText" && texts[0].text).toBe("The quick brown fox.");
    expect(texts[0].kind === "assistantText" && texts[0].streaming).toBe(false);
  });

  it("repairs a dropped delta, because the finished block is authoritative", () => {
    apply(delta("The quick brwn"));
    apply({ type: "message", role: "assistant", text: "The quick brown fox." });
    const texts = assistantText();
    expect(texts[0].kind === "assistantText" && texts[0].text).toBe("The quick brown fox.");
  });

  it("starts a new block when something interrupts the prose", () => {
    // Aider streams without ever sending a consolidated block, so the only
    // thing that closes one is the next non-text event. (Cursor was once
    // believed to behave this way too — it doesn't, and treating its
    // consolidated re-send as one more delta is what printed its replies
    // twice; see `cursor_agent.rs::is_consolidated_assistant`.)
    apply(delta("Let me look."), toolCall, delta("Found it."));
    const texts = assistantText();
    expect(texts).toHaveLength(2);
    expect(texts[0].kind === "assistantText" && texts[0].streaming).toBe(false);
    expect(texts[1].kind === "assistantText" && texts[1].text).toBe("Found it.");
    // Order matters: the tool call has to sit between the two.
    expect(state().items.map((item) => item.kind)).toEqual([
      "user",
      "assistantText",
      "toolCall",
      "assistantText",
    ]);
  });

  it("closes the stream when the turn ends", () => {
    apply(delta("All done."), {
      type: "turnResult",
      sessionId: "s",
      isError: false,
      totalCostUsd: null,
      durationMs: 10,
      numTurns: 1,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      contextWindow: null,
      resultText: null,
    });
    const texts = assistantText();
    expect(texts[0].kind === "assistantText" && texts[0].streaming).toBe(false);
  });

  it("appends normally for a provider that doesn't stream", () => {
    apply(
      { type: "message", role: "assistant", text: "First." },
      { type: "message", role: "assistant", text: "Second." },
    );
    expect(assistantText().map((item) => item.kind === "assistantText" && item.text)).toEqual([
      "First.",
      "Second.",
    ]);
  });
});

describe("turn results", () => {
  it("records usage so the transcript can report tokens, not just time", () => {
    apply({
      type: "turnResult",
      sessionId: "sess-1",
      isError: false,
      totalCostUsd: 0.07,
      durationMs: 4990,
      numTurns: 2,
      inputTokens: 4,
      outputTokens: 186,
      cacheReadTokens: 42014,
      cacheWriteTokens: 9869,
      contextWindow: 1000000,
      resultText: "done",
    });

    expect(state().status).toBe("idle");
    expect(state().lastResult).toMatchObject({
      sessionId: "sess-1",
      inputTokens: 4,
      outputTokens: 186,
      cacheReadTokens: 42014,
    });
    const items = state().items;
    const completion = items[items.length - 1];
    expect(completion?.kind === "turnComplete" && completion.durationMs).toBe(4990);
  });

  it("surfaces a failed turn as an error rather than a silent success", () => {
    apply({
      type: "turnResult",
      sessionId: "sess-1",
      isError: true,
      totalCostUsd: null,
      durationMs: 0,
      numTurns: 1,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      contextWindow: null,
      resultText: "You've hit your usage limit.",
    });

    expect(state().status).toBe("error");
    expect(state().errorMessage).toBe("You've hit your usage limit.");
  });
});

describe("sending a new message instead of answering", () => {
  it("retires the stale permission prompt rather than leaving it live", () => {
    apply(toolCall, denied, { type: "awaitingPermission", toolUseId: "toolu_1" });
    useAgentSessionStore.getState().appendUserMessage(RUN, "never mind, do it another way");

    const item = state().items.find((entry) => entry.kind === "toolCall");
    // Still-pending would mean an Approve button that resumes an action the
    // conversation has already moved past.
    expect(item?.kind === "toolCall" && item.permission).toEqual({ status: "denied" });
    expect(state().status).toBe("working");
  });
});

describe("message queue", () => {
  it("holds messages in order and hands them back one at a time", () => {
    const store = useAgentSessionStore.getState();
    store.queueMessage(RUN, "first");
    store.queueMessage(RUN, "second");
    expect(state().queued).toEqual(["first", "second"]);

    expect(useAgentSessionStore.getState().takeQueuedMessage(RUN)).toBe("first");
    expect(state().queued).toEqual(["second"]);
    expect(useAgentSessionStore.getState().takeQueuedMessage(RUN)).toBe("second");
    expect(state().queued).toEqual([]);
    expect(useAgentSessionStore.getState().takeQueuedMessage(RUN)).toBeNull();
  });

  it("lets a queued message be withdrawn before it is sent", () => {
    const store = useAgentSessionStore.getState();
    store.queueMessage(RUN, "first");
    store.queueMessage(RUN, "second");
    store.queueMessage(RUN, "third");
    useAgentSessionStore.getState().unqueueMessage(RUN, 1);
    expect(state().queued).toEqual(["first", "third"]);
  });
});

describe("hydrating a restored tab", () => {
  const context = { kind: "claudeCode" as const, worktreeId: "w1", worktreeRoot: "/repo" };

  const stored = [
    { id: "item-1", kind: "user", text: "hello" },
    { id: "item-2", kind: "assistantText", text: "hi" },
  ];

  it("restores the conversation and reconnects the CLI session", async () => {
    api.loadAgentTranscript.mockResolvedValueOnce({
      items: JSON.stringify(stored),
      cliSessionId: "sess-9",
    });
    useAgentSessionStore.setState({ byRunId: {}, unlistenByRunId: {} });

    await useAgentSessionStore.getState().hydrateRun(RUN, context);

    expect(state().items).toHaveLength(2);
    // `started` is what makes the next message continue the session
    // instead of opening a new one.
    expect(state().started).toBe(true);
    expect(state().lastResult?.sessionId).toBe("sess-9");
    expect(api.resumeAgentSession).toHaveBeenCalledWith(RUN, "w1", "/repo", "claudeCode", "sess-9");
  });

  it("re-mints item ids so they can't alias this session's items", async () => {
    api.loadAgentTranscript.mockResolvedValueOnce({
      items: JSON.stringify(stored),
      cliSessionId: null,
    });
    useAgentSessionStore.setState({ byRunId: {}, unlistenByRunId: {} });

    await useAgentSessionStore.getState().hydrateRun(RUN, context);
    // Restored ids colliding with freshly-minted ones would make two
    // different messages share a React key.
    expect(state().items.map((item) => item.id)).not.toEqual(["item-1", "item-2"]);
    expect(new Set(state().items.map((item) => item.id)).size).toBe(2);
  });

  it("keeps the history but starts a new session when there is no session id", async () => {
    api.loadAgentTranscript.mockResolvedValueOnce({
      items: JSON.stringify(stored),
      cliSessionId: null,
    });
    useAgentSessionStore.setState({ byRunId: {}, unlistenByRunId: {} });

    await useAgentSessionStore.getState().hydrateRun(RUN, context);
    expect(state().items).toHaveLength(2);
    expect(state().started).toBe(false);
  });

  it("never clobbers a run that already has a live conversation", async () => {
    api.loadAgentTranscript.mockResolvedValueOnce({
      items: JSON.stringify(stored),
      cliSessionId: "sess-9",
    });
    useAgentSessionStore.getState().appendUserMessage(RUN, "live message");

    await useAgentSessionStore.getState().hydrateRun(RUN, context);
    // The two live messages survive; nothing was read from disk at all.
    expect(state().items.map((item) => item.kind)).toEqual(["user", "user"]);
    expect(api.loadAgentTranscript).not.toHaveBeenCalled();
  });

  it("starts empty rather than rendering an unreadable payload", async () => {
    api.loadAgentTranscript.mockResolvedValueOnce({ items: "not json", cliSessionId: null });
    useAgentSessionStore.setState({ byRunId: {}, unlistenByRunId: {} });

    await useAgentSessionStore.getState().hydrateRun(RUN, context);
    expect(useAgentSessionStore.getState().byRunId[RUN]).toBeUndefined();
  });
});

describe("rewinding to an earlier message", () => {
  it("loads the message back into the composer", () => {
    const itemId = state().items[0].id;
    useAgentSessionStore.getState().beginEditing(RUN, itemId);
    expect(useAgentSessionStore.getState().editingByRunId[RUN]).toBe(itemId);
    expect(useAgentSessionStore.getState().draftByRunId[RUN]).toBe("write a.txt");
  });

  it("refuses to edit anything but a user message", () => {
    apply({ type: "message", role: "assistant", text: "my answer" });
    const assistantId = state().items[1].id;
    useAgentSessionStore.getState().beginEditing(RUN, assistantId);
    // Editing the agent's own words would desync the transcript from the
    // session it claims to represent.
    expect(useAgentSessionStore.getState().editingByRunId[RUN]).toBeUndefined();
  });

  it("drops the message and everything after it", () => {
    apply(
      { type: "message", role: "assistant", text: "first answer" },
      { type: "toolCall", id: "t1", name: "Read", input: {} },
    );
    useAgentSessionStore.getState().appendUserMessage(RUN, "second question");
    apply({ type: "message", role: "assistant", text: "second answer" });

    const secondQuestion = state().items.find(
      (item) => item.kind === "user" && item.text === "second question",
    );
    useAgentSessionStore.getState().truncateFrom(RUN, secondQuestion!.id);

    expect(state().items.map((item) => item.kind)).toEqual(["user", "assistantText", "toolCall"]);
  });

  it("clears the editing marker once the rewind lands", () => {
    const itemId = state().items[0].id;
    useAgentSessionStore.getState().beginEditing(RUN, itemId);
    useAgentSessionStore.getState().truncateFrom(RUN, itemId);
    expect(useAgentSessionStore.getState().editingByRunId[RUN]).toBeNull();
    expect(state().items).toHaveLength(0);
  });

  it("cancelling leaves the transcript untouched", () => {
    const itemId = state().items[0].id;
    useAgentSessionStore.getState().beginEditing(RUN, itemId);
    useAgentSessionStore.getState().cancelEditing(RUN);
    expect(useAgentSessionStore.getState().editingByRunId[RUN]).toBeNull();
    expect(useAgentSessionStore.getState().draftByRunId[RUN]).toBe("");
    expect(state().items).toHaveLength(1);
  });
});

describe("setIdle", () => {
  it("settles a denied turn without pretending the agent is still running", () => {
    apply(toolCall, denied, { type: "awaitingPermission", toolUseId: "toolu_1" });
    useAgentSessionStore.getState().setIdle(RUN);
    expect(state().status).toBe("idle");
    expect(state().turnStartedAtMs).toBeNull();
  });
});
