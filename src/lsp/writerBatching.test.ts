import { beforeEach, describe, expect, it, vi } from "vitest";

/** Captures what reaches the IPC boundary. The writer batches into
 * `send_lsp_messages`, so each entry here is one `invoke` — which is
 * exactly what these tests are about. */
const sent: string[][] = [];
let resolveInFlight: (() => void) | null = null;
let blockNextCall = false;

vi.mock("../api/lsp", () => ({
  lspApi: {
    sendMessages: vi.fn((_worktreeId: string, _kind: string, _gen: string, messages: string[]) => {
      sent.push(messages);
      if (blockNextCall) {
        blockNextCall = false;
        return new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        });
      }
      return Promise.resolve();
    }),
  },
}));

const { TauriMessageWriter } = await import("./transport");

function makeWriter() {
  return new TauriMessageWriter(
    "worktree-1",
    "typeScript",
    Promise.resolve({ worktreeId: "worktree-1", kind: "typeScript", generation: "gen-1" } as never),
  );
}

function notification(n: number) {
  return { jsonrpc: "2.0", method: "textDocument/didChange", params: { n } } as never;
}

/** Lets queued microtasks and the mocked `invoke` promises settle. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("TauriMessageWriter batching", () => {
  beforeEach(() => {
    sent.length = 0;
    resolveInFlight = null;
    blockNextCall = false;
  });

  it("coalesces messages written in the same microtask turn into one IPC call", async () => {
    const writer = makeWriter();
    await Promise.all([
      writer.write(notification(1)),
      writer.write(notification(2)),
      writer.write(notification(3)),
    ]);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(3);
    expect(sent[0].map((m) => JSON.parse(m).params.n)).toEqual([1, 2, 3]);
  });

  it("resolves write() without waiting on the IPC round-trip", async () => {
    blockNextCall = true;
    const writer = makeWriter();

    let resolved = false;
    void writer.write(notification(1)).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);

    // The flush is still out; releasing it must not error.
    await settle();
    resolveInFlight?.();
    await settle();
  });

  it("never has two batches in flight at once, and preserves order across them", async () => {
    blockNextCall = true;
    const writer = makeWriter();

    void writer.write(notification(1));
    await settle();
    // First batch is out and deliberately unresolved.
    expect(sent).toHaveLength(1);

    // Writes arriving while that batch is in flight must not start a second
    // concurrent `invoke` — concurrent invokes have no ordering guarantee.
    void writer.write(notification(2));
    void writer.write(notification(3));
    await settle();
    expect(sent).toHaveLength(1);

    resolveInFlight?.();
    await settle();

    expect(sent).toHaveLength(2);
    expect(sent[0].map((m) => JSON.parse(m).params.n)).toEqual([1]);
    expect(sent[1].map((m) => JSON.parse(m).params.n)).toEqual([2, 3]);
  });

  it("surfaces a failed flush through the connection's error handler", async () => {
    const { lspApi } = await import("../api/lsp");
    vi.mocked(lspApi.sendMessages).mockRejectedValueOnce(new Error("server gone"));

    const writer = makeWriter();
    const errors: unknown[] = [];
    writer.onError(([error]) => errors.push(error));

    void writer.write(notification(1));
    await settle();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("server gone");
  });
});
