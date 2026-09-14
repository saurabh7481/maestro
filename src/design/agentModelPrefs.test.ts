import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stands in for the Tauri store plugin — a plain map, so a test can
 * assert what actually got written under which key. */
const backing = new Map<string, unknown>();
const store = {
  get: vi.fn(async (key: string) => backing.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    backing.set(key, value);
  }),
};

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => store }));

const { loadAgentModelPref, saveAgentModelPref } = await import("./persistence");

describe("agent model preference", () => {
  beforeEach(() => {
    backing.clear();
    vi.clearAllMocks();
  });

  it("remembers a choice for the worktree it was made in", async () => {
    await saveAgentModelPref("wt-a", "claudeCode", "opus");
    expect(await loadAgentModelPref("wt-a", "claudeCode")).toBe("opus");
  });

  /** The reported bug: picking a model in one worktree changed what every
   * other worktree's next tab started on. */
  it("does not leak that choice into another worktree", async () => {
    await saveAgentModelPref("wt-a", "claudeCode", "opus");
    expect(await loadAgentModelPref("wt-b", "claudeCode")).toBeNull();

    await saveAgentModelPref("wt-b", "claudeCode", "haiku");
    expect(await loadAgentModelPref("wt-a", "claudeCode")).toBe("opus");
    expect(await loadAgentModelPref("wt-b", "claudeCode")).toBe("haiku");
  });

  it("keeps providers apart within the same worktree", async () => {
    await saveAgentModelPref("wt-a", "claudeCode", "opus");
    await saveAgentModelPref("wt-a", "cursorAgent", "grok");

    expect(await loadAgentModelPref("wt-a", "claudeCode")).toBe("opus");
    expect(await loadAgentModelPref("wt-a", "cursorAgent")).toBe("grok");
  });

  it("reports nothing remembered rather than a stale global default", async () => {
    expect(await loadAgentModelPref("wt-new", "codex")).toBeNull();
  });
});
