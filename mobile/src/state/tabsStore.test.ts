import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcess } from "../api/types";

let onStreamMessage: ((raw: string) => void) | null = null;
let streamPath: string | null = null;
const closeStream = vi.fn();

vi.mock("../api/stream", () => ({
  openStream: (path: string | (() => string), onMessage: (raw: string) => void) => {
    streamPath = typeof path === "function" ? path() : path;
    onStreamMessage = onMessage;
    return closeStream;
  },
}));

const relayClient = { listAllSessions: vi.fn() };
vi.mock("../api/client", () => ({ relayClient }));

const { useTabsStore, startTabsPolling } = await import("./tabsStore");

function session(id: string, overrides: Partial<ManagedProcess> = {}): ManagedProcess {
  return {
    id,
    kind: "agent",
    label: id,
    detail: null,
    worktreeId: "wt",
    worktreeRoot: "/repo",
    tabId: id,
    pid: null,
    startedAtMs: 0,
    status: "idle",
    agentKind: "cursorAgent",
    ...overrides,
  };
}

function pushFrame(sessions: ManagedProcess[]) {
  onStreamMessage!(JSON.stringify({ sessions }));
}

describe("tabsStore live session list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onStreamMessage = null;
    streamPath = null;
    relayClient.listAllSessions.mockResolvedValue([]);
    useTabsStore.setState({ sessions: [], activeTabId: null, pushRevision: 0 });
  });

  it("subscribes to the pushed list rather than waiting on a poll", () => {
    const stop = startTabsPolling();
    expect(streamPath).toBe("/api/sessions/stream");
    stop();
    expect(closeStream).toHaveBeenCalled();
  });

  /** The gap this closes: a title generated on the desktop used to take a
   * poll tick to reach the dock. */
  it("applies a renamed session the moment it is pushed", () => {
    const stop = startTabsPolling();
    pushFrame([session("run-1", { label: "Cursor Agent" })]);
    expect(useTabsStore.getState().sessions[0].label).toBe("Cursor Agent");

    pushFrame([session("run-1", { label: "payment-fix", status: "running" })]);
    expect(useTabsStore.getState().sessions[0]).toMatchObject({
      label: "payment-fix",
      status: "running",
    });
    stop();
  });

  it("clears the active tab when its session disappears from a push", () => {
    const stop = startTabsPolling();
    pushFrame([session("run-1")]);
    useTabsStore.getState().setActive("run-1");

    pushFrame([]);
    expect(useTabsStore.getState().activeTabId).toBeNull();
    stop();
  });

  it("ignores a malformed frame instead of blanking the dock", () => {
    const stop = startTabsPolling();
    pushFrame([session("run-1")]);

    onStreamMessage!("not json");
    onStreamMessage!(JSON.stringify({ sessions: "nope" }));

    expect(useTabsStore.getState().sessions).toHaveLength(1);
    stop();
  });

  /** A reconcile in flight when a push lands is older than the push, and
   * must not flick the dock back to the list it captured. */
  it("does not let a slow reconcile overwrite a newer push", async () => {
    let resolvePoll!: (value: ManagedProcess[]) => void;
    relayClient.listAllSessions.mockReturnValue(
      new Promise<ManagedProcess[]>((r) => (resolvePoll = r)),
    );

    const stop = startTabsPolling();
    const inFlight = useTabsStore.getState().refresh();
    pushFrame([session("run-2", { label: "newer" })]);
    resolvePoll([session("run-1", { label: "stale" })]);
    await inFlight;

    expect(useTabsStore.getState().sessions[0].label).toBe("newer");
    stop();
  });

  it("keeps the last-known list when the reconcile poll fails", async () => {
    const stop = startTabsPolling();
    pushFrame([session("run-1")]);

    relayClient.listAllSessions.mockRejectedValue(new Error("offline"));
    await useTabsStore.getState().refresh();

    expect(useTabsStore.getState().sessions).toHaveLength(1);
    stop();
  });
});
