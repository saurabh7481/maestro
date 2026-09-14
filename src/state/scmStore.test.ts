import { beforeEach, describe, expect, it, vi } from "vitest";

const gitApi = {
  pullChanges: vi.fn(),
  pushChanges: vi.fn(),
  fetchRemote: vi.fn(),
  getWorkingStatus: vi.fn(),
};

vi.mock("../api/git", () => ({ gitApi }));
vi.mock("../api/scmEvents", () => ({ listenToScmEvents: vi.fn() }));

const { useScmStore, toRemoteError } = await import("./scmStore");
const { useToastStore } = await import("./toastStore");
const { useUiStore } = await import("./uiStore");

import type { GitRemoteError } from "../types/git";

const blockedByLocalChanges: GitRemoteError = {
  code: "dirtyWorkingTree",
  title: "Pull blocked by local changes",
  message: "Pulling would overwrite files you've edited.",
  detail:
    "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts",
  paths: ["src/a.ts"],
  actions: ["stashAndPull", "retry"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("scmStore remote operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    useUiStore.setState({ rightSidebarOpen: true, sidebarView: "scm" });
    useScmStore.setState({
      worktreeId: "wt",
      worktreeRoot: "/repo",
      error: null,
      busy: null,
      commits: [],
      commitsExhausted: false,
    });
  });

  it("reports what a successful pull did, and clears any previous error", async () => {
    useScmStore.setState({ error: blockedByLocalChanges });
    gitApi.pullChanges.mockResolvedValue({
      summary: "Pulled 198 commits from origin/sayar",
      stashConflict: false,
    });

    await useScmStore.getState().pull();

    expect(gitApi.pullChanges).toHaveBeenCalledWith("wt", "/repo", "fastForward");
    expect(useScmStore.getState().error).toBeNull();
    expect(useScmStore.getState().busy).toBeNull();
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      tone: "success",
      title: "Pulled 198 commits from origin/sayar",
    });
  });

  it("keeps a failed pull's structured error instead of stringifying it", async () => {
    gitApi.pullChanges.mockRejectedValue(blockedByLocalChanges);

    await expect(useScmStore.getState().pull()).rejects.toBe(blockedByLocalChanges);

    expect(useScmStore.getState().error).toEqual(blockedByLocalChanges);
    expect(useScmStore.getState().busy).toBeNull();
    // The panel is on screen and already shows the whole failure.
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toasts a failure the Source Control panel isn't there to show", async () => {
    useUiStore.setState({ sidebarView: "explorer" });
    gitApi.pullChanges.mockRejectedValue(blockedByLocalChanges);

    await expect(useScmStore.getState().pull()).rejects.toBe(blockedByLocalChanges);

    expect(useToastStore.getState().toasts[0]).toMatchObject({
      tone: "error",
      title: "Pull blocked by local changes",
    });
  });

  it("refuses to start a second operation while one is in flight", async () => {
    const pending = deferred<{ summary: string }>();
    gitApi.pullChanges.mockReturnValue(pending.promise);

    const first = useScmStore.getState().pull();
    expect(useScmStore.getState().busy).toBe("pull");

    await useScmStore.getState().push();
    expect(gitApi.pushChanges).not.toHaveBeenCalled();

    pending.resolve({ summary: "Already up to date with origin/main" });
    await first;
    expect(useScmStore.getState().busy).toBeNull();
  });

  it("passes the chosen strategy through, so a remedy isn't a plain retry", async () => {
    gitApi.pullChanges.mockResolvedValue({ summary: "Pulled 1 commit" });
    await useScmStore.getState().pull("stashFastForward");
    expect(gitApi.pullChanges).toHaveBeenCalledWith("wt", "/repo", "stashFastForward");

    gitApi.pushChanges.mockResolvedValue({ summary: "Pushed 1 commit" });
    await useScmStore.getState().push(true);
    expect(gitApi.pushChanges).toHaveBeenCalledWith("wt", "/repo", true);
  });

  it("does not push when the pull half of pull-then-push fails", async () => {
    gitApi.pullChanges.mockRejectedValue(blockedByLocalChanges);

    await useScmStore.getState().pullThenPush();

    expect(gitApi.pushChanges).not.toHaveBeenCalled();
    expect(useScmStore.getState().error).toEqual(blockedByLocalChanges);
  });

  it("retries the operation that failed, with the options it failed under", async () => {
    gitApi.pushChanges.mockRejectedValueOnce(blockedByLocalChanges);
    await expect(useScmStore.getState().push(true)).rejects.toBeTruthy();

    gitApi.pushChanges.mockResolvedValue({ summary: "Pushed 1 commit" });
    await useScmStore.getState().retryLastRemote();

    expect(gitApi.pushChanges).toHaveBeenLastCalledWith("wt", "/repo", true);
  });
});

describe("toRemoteError", () => {
  it("passes a structured backend error through untouched", () => {
    expect(toRemoteError(blockedByLocalChanges, "Pull failed")).toBe(blockedByLocalChanges);
  });

  it("wraps the bare strings local git commands still reject with", () => {
    const error = toRemoteError(
      "fatal: pathspec 'x' did not match any files\nsecond line",
      "Stage failed",
    );
    expect(error).toMatchObject({
      code: "unknown",
      title: "Stage failed",
      message: "fatal: pathspec 'x' did not match any files",
      paths: [],
      actions: [],
    });
    // The full text is kept for the details disclosure.
    expect(error.detail).toContain("second line");
  });

  it("wraps a thrown Error without losing its message", () => {
    expect(toRemoteError(new Error("boom"), "Commit failed")).toMatchObject({
      title: "Commit failed",
      message: "boom",
      detail: "boom",
    });
  });
});
