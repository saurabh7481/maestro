import { beforeEach, describe, expect, it } from "vitest";
import { panesForWorktree, tabsInPane, useTabsStore, type Tab } from "./tabsStore";
import { collectPaneIds } from "./paneLayout";

function tab(id: string, worktreeRoot = "/wt/main"): Tab {
  return { id, type: "file", title: id, worktreeRoot, filePath: `${id}.ts` };
}

function state() {
  return useTabsStore.getState();
}

function panes(worktreeRoot = "/wt/main") {
  return panesForWorktree(state(), worktreeRoot);
}

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    panes: {},
    layouts: {},
    activePaneByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
  });
});

describe("opening and closing", () => {
  it("creates a pane for the first tab of a worktree", () => {
    state().openTab(tab("a"));
    expect(panes()).toHaveLength(1);
    expect(tabsInPane(state(), panes()[0].id).map((t) => t.id)).toEqual(["a"]);
    expect(state().activeTabId).toBe("a");
  });

  it("keeps later tabs in the same pane, in open order", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    expect(panes()).toHaveLength(1);
    expect(panes()[0].tabIds).toEqual(["a", "b"]);
  });

  it("activates a neighbour when the active tab closes", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().openTab(tab("c"));
    state().setActiveTab("b");
    state().closeTab("b");
    expect(state().activeTabId).toBe("c");
  });

  it("keeps the last empty pane rather than leaving the worktree paneless", () => {
    state().openTab(tab("a"));
    state().closeTab("a");
    expect(panes()).toHaveLength(1);
    expect(panes()[0].tabIds).toEqual([]);
    expect(state().activeTabId).toBeNull();
  });

  it("buckets tabs of different worktrees into different panes", () => {
    state().openTab(tab("a", "/wt/main"));
    state().openTab(tab("b", "/wt/feature"));
    expect(panes("/wt/main")).toHaveLength(1);
    expect(panes("/wt/feature")).toHaveLength(1);
    expect(panes("/wt/main")[0].id).not.toBe(panes("/wt/feature")[0].id);
  });
});

describe("splitting", () => {
  it("moves the active tab into a new pane beside the old one", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    const paneId = panes()[0].id;
    const newPaneId = state().splitPane(paneId, "right");
    expect(newPaneId).toBeTruthy();
    expect(panes()).toHaveLength(2);
    expect(panes()[0].tabIds).toEqual(["a"]);
    expect(panes()[1].tabIds).toEqual(["b"]);
    expect(state().activeTabId).toBe("b");
  });

  it("refuses to split a pane holding only the tab being moved", () => {
    state().openTab(tab("a"));
    expect(state().splitPane(panes()[0].id, "right")).toBeNull();
    expect(panes()).toHaveLength(1);
  });

  it("places a `left` split before the source pane", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    const paneId = panes()[0].id;
    const newPaneId = state().splitPane(paneId, "left");
    expect(panes()[0].id).toBe(newPaneId);
  });

  it("splits with a named tab that lives in another pane", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().openTab(tab("c"));
    const first = panes()[0].id;
    // The active tab (`c`) moves into the new pane, leaving `a`/`b` behind.
    const second = state().splitPane(first, "right")!;
    // `a` is still in the first pane; drop it on the second pane's bottom.
    state().splitPane(second, "bottom", "a");
    expect(panes()).toHaveLength(3);
    expect(
      panes()
        .flatMap((p) => p.tabIds)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("collapses the split back when the last tab of a pane closes", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    const paneId = panes()[0].id;
    state().splitPane(paneId, "right");
    expect(panes()).toHaveLength(2);
    state().closeTab("b");
    expect(panes()).toHaveLength(1);
    expect(collectPaneIds(state().layouts["/wt/main"])).toEqual([paneId]);
  });
});

describe("moving tabs", () => {
  it("reorders within a pane", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().openTab(tab("c"));
    const paneId = panes()[0].id;
    state().moveTab("a", paneId, 2);
    expect(panes()[0].tabIds).toEqual(["b", "a", "c"]);
  });

  it("treats the drop index as measured against the pane the user sees", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().openTab(tab("c"));
    const paneId = panes()[0].id;
    // Dropping `c` at index 0 puts it first; dropping `a` at index 3 puts
    // it last. Both are the indices the strip reports under the pointer.
    state().moveTab("c", paneId, 0);
    expect(panes()[0].tabIds).toEqual(["c", "a", "b"]);
    state().moveTab("c", paneId, 3);
    expect(panes()[0].tabIds).toEqual(["a", "b", "c"]);
  });

  it("moves a tab across panes and focuses it there", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().openTab(tab("c"));
    const first = panes()[0].id;
    const second = state().splitPane(first, "right")!;
    state().moveTab("a", second, 0);
    expect(panes()[0].tabIds).toEqual(["b"]);
    expect(panes()[1].tabIds).toEqual(["a", "c"]);
    expect(state().activeTabId).toBe("a");
  });

  it("collapses the source pane when its last tab moves away", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    const first = panes()[0].id;
    const second = state().splitPane(first, "right")!;
    state().moveTab("a", second, 0);
    expect(panes()).toHaveLength(1);
    expect(panes()[0].id).toBe(second);
  });
});

describe("worktree switching", () => {
  it("restores the tab that was last active in that worktree", () => {
    state().openTab(tab("a", "/wt/main"));
    state().openTab(tab("b", "/wt/main"));
    state().setActiveTab("a");
    state().openTab(tab("c", "/wt/feature"));
    state().switchToWorktree("/wt/main");
    expect(state().activeTabId).toBe("a");
    state().switchToWorktree("/wt/feature");
    expect(state().activeTabId).toBe("c");
  });

  it("reports no active tab for a worktree with no panes", () => {
    state().openTab(tab("a", "/wt/main"));
    state().switchToWorktree("/wt/unknown");
    expect(state().activeTabId).toBeNull();
  });
});

describe("handing tabs between windows", () => {
  it("releases tabs without disturbing the ones left behind", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().releaseTabs(["b"]);
    expect(state().tabs.map((t) => t.id)).toEqual(["a"]);
    expect(panes()[0].tabIds).toEqual(["a"]);
    expect(state().activeTabId).toBe("a");
  });

  it("adopts tabs into a worktree pane, creating one if needed", () => {
    state().adoptTabs([tab("x"), tab("y")]);
    expect(panes()).toHaveLength(1);
    expect(panes()[0].tabIds).toEqual(["x", "y"]);
    expect(state().activeTabId).toBe("y");
  });

  it("ignores a duplicate adoption of a tab it already has", () => {
    state().openTab(tab("a"));
    state().adoptTabs([tab("a")]);
    expect(state().tabs).toHaveLength(1);
    expect(panes()[0].tabIds).toEqual(["a"]);
  });
});

describe("hydrate", () => {
  it("drops panes whose tabs are all gone and keeps the rest", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    const first = panes()[0].id;
    state().splitPane(first, "right");
    const saved = {
      tabs: state().tabs,
      panes: state().panes,
      layouts: state().layouts,
      activePaneByWorktree: state().activePaneByWorktree,
      activeTabId: state().activeTabId,
      activeTabIdByWorktree: state().activeTabIdByWorktree,
    };

    // Restore with only one of the two tabs still valid.
    useTabsStore.setState({ tabs: [], panes: {}, layouts: {}, activePaneByWorktree: {} });
    state().hydrate({ ...saved, tabs: saved.tabs.filter((t) => t.id === "a") });
    expect(panes()).toHaveLength(1);
    expect(panes()[0].tabIds).toEqual(["a"]);
  });

  it("rehomes a tab whose pane didn't survive rather than losing it", () => {
    state().hydrate({
      tabs: [tab("a"), tab("b")],
      panes: {},
      layouts: {},
      activePaneByWorktree: {},
      activeTabId: null,
      activeTabIdByWorktree: {},
    });
    expect(panes()).toHaveLength(1);
    expect(panes()[0].tabIds).toEqual(["a", "b"]);
  });

  it("restores a two-pane split intact", () => {
    state().openTab(tab("a"));
    state().openTab(tab("b"));
    state().splitPane(panes()[0].id, "right");
    const saved = {
      tabs: state().tabs,
      panes: state().panes,
      layouts: state().layouts,
      activePaneByWorktree: state().activePaneByWorktree,
      activeTabId: state().activeTabId,
      activeTabIdByWorktree: state().activeTabIdByWorktree,
    };
    useTabsStore.setState({ tabs: [], panes: {}, layouts: {}, activePaneByWorktree: {} });
    state().hydrate(saved);
    expect(panes()).toHaveLength(2);
    expect(panes().map((p) => p.tabIds)).toEqual([["a"], ["b"]]);
  });
});
