import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../api/types";

/** Captures what the store hands `openStream`, so a test can feed frames
 * in and inspect the URL each (re)connect would request. */
let handlers: {
  path: () => string;
  onMessage: (raw: string) => void;
} | null = null;

vi.mock("../api/stream", () => ({
  openStream: (path: string | (() => string), onMessage: (raw: string) => void) => {
    handlers = { path: typeof path === "function" ? path : () => path, onMessage };
    return () => {};
  },
}));

const relayClient = { getAgentTranscript: vi.fn() };
vi.mock("../api/client", () => ({ relayClient }));

const { useAgentStore } = await import("./agentStore");

const RUN = "run-1";

function snapshotFrame(
  events: { seq: number; event: AgentEvent }[],
  overrides: Partial<{ status: string; seq: number; truncated: boolean; cold: boolean }> = {},
) {
  return JSON.stringify({
    frame: "snapshot",
    snapshot: {
      status: "working",
      seq: events.at(-1)?.seq ?? 0,
      events,
      truncated: false,
      cold: false,
      ...overrides,
    },
  });
}

function eventFrame(seq: number, event: AgentEvent) {
  return JSON.stringify({ frame: "event", event: { seq, event } });
}

const userMsg = (text: string): AgentEvent => ({ type: "message", role: "user", text });
const delta = (text: string): AgentEvent => ({ type: "messageDelta", text });

function transcriptText(): string {
  return (useAgentStore.getState().byRunId[RUN]?.items ?? [])
    .map((item) => ("text" in item ? item.text : ""))
    .join("");
}

describe("agentStore live sync", () => {
  beforeEach(() => {
    handlers = null;
    vi.clearAllMocks();
    relayClient.getAgentTranscript.mockResolvedValue(null);
    useAgentStore.setState({
      byRunId: {},
      streamStatusByRunId: {},
      closersByRunId: {},
      lastSeqByRunId: {},
    });
  });

  /** The reported bug: a turn started on the desktop left the phone
   * showing "idle", because status was only ever set by the client that
   * sent the prompt. The snapshot now states it. */
  it("adopts the run status the server reports, whoever started the turn", () => {
    useAgentStore.getState().open(RUN);
    handlers!.onMessage(snapshotFrame([{ seq: 1, event: userMsg("do the thing") }]));

    expect(useAgentStore.getState().byRunId[RUN].status).toBe("working");
  });

  it("rebuilds the whole conversation from the backlog on a cold attach", () => {
    useAgentStore.getState().open(RUN);
    handlers!.onMessage(
      snapshotFrame([
        { seq: 1, event: userMsg("hello") },
        { seq: 2, event: delta("hi ") },
        { seq: 3, event: delta("there") },
      ]),
    );

    expect(transcriptText()).toBe("hellohi there");
    expect(useAgentStore.getState().lastSeqByRunId[RUN]).toBe(3);
  });

  it("asks to resume from the last sequence it saw", () => {
    useAgentStore.getState().open(RUN);
    expect(handlers!.path()).toContain("since=0");

    handlers!.onMessage(snapshotFrame([{ seq: 1, event: userMsg("hello") }]));
    handlers!.onMessage(eventFrame(2, delta("partial")));

    expect(handlers!.path()).toContain("since=2");
  });

  /** The reconnect seam: a resume backlog must extend the transcript, not
   * replace it, and must not re-apply anything already shown. */
  it("resumes without losing or duplicating the events around a drop", () => {
    useAgentStore.getState().open(RUN);
    handlers!.onMessage(
      snapshotFrame([
        { seq: 1, event: userMsg("hello") },
        { seq: 2, event: delta("one ") },
      ]),
    );
    expect(transcriptText()).toBe("helloone ");

    // Socket drops; the server replays 2 (already seen) and 3 (missed).
    handlers!.onMessage(
      snapshotFrame(
        [
          { seq: 2, event: delta("one ") },
          { seq: 3, event: delta("two") },
        ],
        { seq: 3 },
      ),
    );

    expect(transcriptText()).toBe("helloone two");
  });

  it("ignores a stale frame that arrives after a newer one", () => {
    useAgentStore.getState().open(RUN);
    handlers!.onMessage(snapshotFrame([{ seq: 1, event: userMsg("hello") }]));
    handlers!.onMessage(eventFrame(2, delta("second")));
    handlers!.onMessage(eventFrame(2, delta("second")));

    expect(transcriptText()).toBe("hellosecond");
  });

  /** A hole is never rendered as if it were the conversation: too-far-
   * behind and desktop-restarted both fall back to the persisted copy. */
  it("falls back to the saved transcript rather than showing a gap", async () => {
    relayClient.getAgentTranscript.mockResolvedValue({
      items: JSON.stringify([{ kind: "assistantText", text: "restored" }]),
      cliSessionId: null,
      lastResult: null,
    });

    useAgentStore.getState().open(RUN);
    handlers!.onMessage(snapshotFrame([], { truncated: true, seq: 99 }));
    await vi.waitFor(() => expect(transcriptText()).toBe("restored"));

    expect(relayClient.getAgentTranscript).toHaveBeenCalledWith(RUN);
  });

  it("hydrates from disk when the desktop has no live log for the run", async () => {
    relayClient.getAgentTranscript.mockResolvedValue({
      items: JSON.stringify([{ kind: "assistantText", text: "from disk" }]),
      cliSessionId: null,
      lastResult: null,
    });

    useAgentStore.getState().open(RUN);
    handlers!.onMessage(snapshotFrame([], { cold: true, status: "idle", seq: 0 }));
    await vi.waitFor(() => expect(transcriptText()).toBe("from disk"));
  });
});
