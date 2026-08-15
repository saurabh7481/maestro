import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MainContent } from "./MainContent";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { Worktree } from "../../types/workspace";

/** Renders the real editor area against the real stores — the pane tree,
 * the per-pane tab strips, and `TabHost`'s portals all have to agree
 * about which pane a tab belongs to, and no amount of store-level testing
 * catches them disagreeing. */

const WORKTREE: Worktree = {
  id: "wt1",
  projectId: "p1",
  path: "/repo",
  branch: "main",
  isPrimary: true,
  isDetached: false,
  isLocked: false,
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: 0,
};

function tab(id: string): Tab {
  return { id, type: "file", title: id, worktreeRoot: "/repo", worktreeId: "wt1", filePath: id };
}

beforeEach(() => {
  useWorkspaceStore.setState({
    projects: [{ id: "p1", name: "repo", rootPath: "/repo", addedAt: "" }],
    worktreesByProject: { p1: [WORKTREE] },
    activeProjectId: "p1",
    activeWorktreeId: "wt1",
    loaded: true,
  });
  useTabsStore.setState({
    tabs: [],
    panes: {},
    layouts: {},
    activePaneByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
  });
});

describe("MainContent", () => {
  it("gives a worktree with no tabs a pane, so the + button still exists", () => {
    render(<MainContent />);
    expect(screen.getByLabelText("New tab")).toBeInTheDocument();
    expect(screen.getByText(/No tabs open/)).toBeInTheDocument();
  });

  it("renders one tab strip per pane after a split", () => {
    render(<MainContent />);
    act(() => {
      useTabsStore.getState().openTab(tab("a"));
      useTabsStore.getState().openTab(tab("b"));
    });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getAllByLabelText("New tab")).toHaveLength(1);

    const paneId = Object.keys(useTabsStore.getState().panes)[0];
    act(() => {
      useTabsStore.getState().splitPane(paneId, "right");
    });

    // Two panes, so two strips and two `+` buttons; each tab appears once.
    expect(screen.getAllByLabelText("New tab")).toHaveLength(2);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getAllByRole("separator", { name: "Resize panes" })).toHaveLength(1);
  });

  it("collapses back to a single pane when a split pane's last tab closes", () => {
    render(<MainContent />);
    act(() => {
      useTabsStore.getState().openTab(tab("a"));
      useTabsStore.getState().openTab(tab("b"));
    });
    const paneId = Object.keys(useTabsStore.getState().panes)[0];
    act(() => {
      useTabsStore.getState().splitPane(paneId, "right");
    });
    act(() => {
      useTabsStore.getState().closeTab("b");
    });
    expect(screen.getAllByLabelText("New tab")).toHaveLength(1);
    expect(screen.queryByRole("separator", { name: "Resize panes" })).not.toBeInTheDocument();
  });

  it("shows only the active worktree's panes", () => {
    render(<MainContent />);
    act(() => {
      useTabsStore.getState().openTab(tab("a"));
      useTabsStore.getState().openTab({
        id: "other",
        type: "file",
        title: "other",
        worktreeRoot: "/elsewhere",
      });
    });
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText("other")).not.toBeInTheDocument();
  });
});
