import { describe, expect, it } from "vitest";
import {
  collectPaneIds,
  containsPane,
  edgeToSplit,
  insertBeside,
  leaf,
  paneCount,
  pruneLayout,
  removePane,
  updateSizes,
  type LayoutNode,
} from "./paneLayout";

function sizesOf(node: LayoutNode): number[] {
  return node.kind === "split" ? node.sizes : [];
}

describe("insertBeside", () => {
  it("turns a lone pane into a split holding both panes", () => {
    const next = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(next).toEqual({
      kind: "split",
      id: "s1",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [0.5, 0.5],
    });
  });

  it("honours `before` by placing the new pane first", () => {
    const next = insertBeside(leaf("a"), "a", "b", "column", true, "s1");
    expect(collectPaneIds(next)).toEqual(["b", "a"]);
  });

  it("joins an existing split of the same direction instead of nesting", () => {
    const two = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const three = insertBeside(two, "b", "c", "row", false, "s2");
    expect(three.kind).toBe("split");
    expect(collectPaneIds(three)).toEqual(["a", "b", "c"]);
    // One flat row, not a split nested inside a split.
    expect((three as { children: LayoutNode[] }).children.every((c) => c.kind === "leaf")).toBe(
      true,
    );
  });

  it("splits the target's own share when joining a same-direction split", () => {
    const two = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const three = insertBeside(two, "b", "c", "row", false, "s2");
    expect(sizesOf(three)).toEqual([0.5, 0.25, 0.25]);
  });

  it("nests when the requested direction crosses the existing one", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const nested = insertBeside(row, "b", "c", "column", false, "s2");
    expect(nested.kind).toBe("split");
    const children = (nested as { children: LayoutNode[] }).children;
    expect(children[0]).toEqual(leaf("a"));
    expect(children[1].kind).toBe("split");
    expect(collectPaneIds(nested)).toEqual(["a", "b", "c"]);
  });

  it("leaves the tree untouched when the target pane isn't in it", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(insertBeside(row, "zz", "c", "row", false, "s2")).toEqual(row);
  });
});

describe("removePane", () => {
  it("returns null when the last pane goes", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("collapses a split back to its surviving child", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(removePane(row, "b")).toEqual(leaf("a"));
  });

  it("keeps a three-way split as a split and renormalizes sizes", () => {
    const two = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const three = insertBeside(two, "b", "c", "row", false, "s2");
    const removed = removePane(three, "a");
    expect(collectPaneIds(removed!)).toEqual(["b", "c"]);
    expect(sizesOf(removed!)).toEqual([0.5, 0.5]);
  });

  it("collapses nested splits from the inside out", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const nested = insertBeside(row, "b", "c", "column", false, "s2");
    const removed = removePane(nested, "c");
    expect(removed).toEqual(row);
  });

  it("ignores a pane id that isn't present", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(removePane(row, "nope")).toEqual(row);
  });
});

describe("updateSizes", () => {
  it("normalizes what a drag commits", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const resized = updateSizes(row, "s1", [300, 100]);
    expect(sizesOf(resized)).toEqual([0.75, 0.25]);
  });

  it("reaches a nested split by id", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const nested = insertBeside(row, "b", "c", "column", false, "s2");
    const resized = updateSizes(nested, "s2", [1, 3]);
    const inner = (resized as { children: LayoutNode[] }).children[1];
    expect(sizesOf(inner)).toEqual([0.25, 0.75]);
  });

  it("ignores a size array of the wrong length", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(updateSizes(row, "s1", [1, 2, 3])).toEqual(row);
  });
});

describe("pruneLayout", () => {
  it("drops panes that no longer exist and collapses what's left", () => {
    const two = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const three = insertBeside(two, "b", "c", "row", false, "s2");
    expect(pruneLayout(three, new Set(["a"]))).toEqual(leaf("a"));
  });

  it("returns null when nothing survives", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(pruneLayout(row, new Set())).toBeNull();
  });

  it("keeps a fully-known layout intact", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    expect(pruneLayout(row, new Set(["a", "b"]))).toEqual(row);
  });
});

describe("tree queries", () => {
  it("counts and finds panes across nesting", () => {
    const row = insertBeside(leaf("a"), "a", "b", "row", false, "s1");
    const nested = insertBeside(row, "b", "c", "column", false, "s2");
    expect(paneCount(nested)).toBe(3);
    expect(containsPane(nested, "c")).toBe(true);
    expect(containsPane(nested, "d")).toBe(false);
  });
});

describe("edgeToSplit", () => {
  it("maps each drop edge to an axis and side", () => {
    expect(edgeToSplit("left")).toEqual({ direction: "row", before: true });
    expect(edgeToSplit("right")).toEqual({ direction: "row", before: false });
    expect(edgeToSplit("top")).toEqual({ direction: "column", before: true });
    expect(edgeToSplit("bottom")).toEqual({ direction: "column", before: false });
  });
});
