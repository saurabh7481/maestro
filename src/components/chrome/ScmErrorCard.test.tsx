import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives";
import { ScmErrorCard } from "./ScmErrorCard";
import { useScmStore } from "../../state/scmStore";
import type { GitRemoteError } from "../../types/git";

/** The failure from the bug report, as `git_remote.rs` now classifies it. */
const blocked: GitRemoteError = {
  code: "dirtyWorkingTree",
  title: "Pull blocked by local changes",
  message: "Pulling would overwrite files you've edited.",
  detail:
    "error: Your local changes to the following files would be overwritten by merge:\n" +
    "\tapps/web/src/pages/api/cron/pre-renewal-invoice-reminders.ts\n" +
    "Please commit your changes or stash them before you merge.\nAborting",
  paths: [
    "apps/web/src/pages/api/cron/pre-renewal-invoice-reminders.ts",
    "apps/web/src/server/trpc/router/payment.ts",
  ],
  actions: ["stashAndPull", "retry"],
};

const rejected: GitRemoteError = {
  code: "rejected",
  title: "Push rejected — the remote moved on",
  message: "The remote branch has commits you don't have locally.",
  detail: "! [rejected] main -> main (fetch first)",
  paths: [],
  actions: ["pullThenPush", "forcePush"],
};

function renderCard(error: GitRemoteError) {
  return render(
    <TooltipProvider>
      <ScmErrorCard error={error} />
    </TooltipProvider>,
  );
}

describe("ScmErrorCard", () => {
  beforeEach(() => {
    useScmStore.setState({
      busy: null,
      error: null,
      pull: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
      pullThenPush: vi.fn().mockResolvedValue(undefined),
      retryLastRemote: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("leads with the explanation and lists the blocking paths, not raw stderr", () => {
    renderCard(blocked);

    expect(screen.getByText("Pull blocked by local changes")).toBeTruthy();
    expect(screen.getByText(/Pulling would overwrite files/)).toBeTruthy();
    for (const path of blocked.paths) expect(screen.getByText(path)).toBeTruthy();
    // Git's own output stays hidden until asked for.
    expect(screen.queryByText(/would be overwritten by merge/)).toBeNull();
  });

  it("keeps git's verbatim output one disclosure away", () => {
    renderCard(blocked);

    fireEvent.click(screen.getByText("Show details"));
    const detail = screen.getByText(/would be overwritten by merge/);
    expect(detail.textContent).toContain("Aborting");

    fireEvent.click(screen.getByText("Hide details"));
    expect(screen.queryByText(/would be overwritten by merge/)).toBeNull();
  });

  it("runs the offered remedy with the strategy it stands for", () => {
    renderCard(blocked);

    fireEvent.click(screen.getByText("Stash & Pull"));
    expect(useScmStore.getState().pull).toHaveBeenCalledWith("stashFastForward");
  });

  it("retries the operation that failed rather than guessing", () => {
    renderCard(blocked);

    fireEvent.click(screen.getByText("Try Again"));
    expect(useScmStore.getState().retryLastRemote).toHaveBeenCalled();
  });

  it("makes force push confirm before it overwrites the remote", () => {
    renderCard(rejected);

    fireEvent.click(screen.getByText("Force Push"));
    expect(useScmStore.getState().push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Overwrite the remote?"));
    expect(useScmStore.getState().push).toHaveBeenCalledWith(true);
  });

  it("disables its remedies while another operation is running", () => {
    useScmStore.setState({ busy: "pull" });
    renderCard(rejected);

    expect(screen.getByText("Pull, then Push").closest("button")?.disabled).toBe(true);
  });

  it("can be dismissed", () => {
    useScmStore.setState({ error: blocked });
    renderCard(blocked);

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(useScmStore.getState().error).toBeNull();
  });
});
