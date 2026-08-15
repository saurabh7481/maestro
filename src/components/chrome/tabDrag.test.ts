import { describe, expect, it } from "vitest";
import {
  edgeAt,
  insertionIndex,
  resolveDropTarget,
  sameTarget,
  type PaneDropGeometry,
  type RectLike,
} from "./tabDrag";

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** One pane occupying x 0–400, with a 30px strip on top and three 100px
 * tabs in it. */
function pane(paneId: string, offsetX = 0): PaneDropGeometry {
  return {
    paneId,
    strip: rect(offsetX, 0, 400, 30),
    content: rect(offsetX, 30, 400, 370),
    tabs: [
      { id: "a", left: offsetX, right: offsetX + 100 },
      { id: "b", left: offsetX + 100, right: offsetX + 200 },
      { id: "c", left: offsetX + 200, right: offsetX + 300 },
    ],
  };
}

describe("insertionIndex", () => {
  const tabs = pane("p").tabs;

  it("inserts before a tab when the pointer is on its left half", () => {
    expect(insertionIndex(tabs, 40)).toBe(0);
    expect(insertionIndex(tabs, 140)).toBe(1);
  });

  it("inserts after a tab when the pointer is on its right half", () => {
    expect(insertionIndex(tabs, 60)).toBe(1);
    expect(insertionIndex(tabs, 260)).toBe(3);
  });

  it("appends past the last tab", () => {
    expect(insertionIndex(tabs, 380)).toBe(3);
  });

  it("returns zero for an empty strip", () => {
    expect(insertionIndex([], 200)).toBe(0);
  });
});

describe("edgeAt", () => {
  const content = rect(0, 0, 400, 400);

  it("picks the nearest edge inside the edge zone", () => {
    expect(edgeAt(content, 10, 200)).toBe("left");
    expect(edgeAt(content, 390, 200)).toBe("right");
    expect(edgeAt(content, 200, 10)).toBe("top");
    expect(edgeAt(content, 200, 390)).toBe("bottom");
  });

  it("returns null in the middle", () => {
    expect(edgeAt(content, 200, 200)).toBeNull();
  });

  it("resolves a corner to whichever edge is proportionally closer", () => {
    // 20px from the left of 400 wide (0.05) vs 40px from the top of 400
    // tall (0.10) — left wins.
    expect(edgeAt(content, 20, 40)).toBe("left");
  });

  it("scales the zone with the rect, not in absolute pixels", () => {
    const narrow = rect(0, 0, 40, 400);
    // 15px in is well past a quarter of a 40px-wide pane.
    expect(edgeAt(narrow, 15, 200)).toBeNull();
    expect(edgeAt(narrow, 5, 200)).toBe("left");
  });

  it("declines to guess for a zero-sized rect", () => {
    expect(edgeAt(rect(0, 0, 0, 0), 0, 0)).toBeNull();
  });
});

describe("resolveDropTarget", () => {
  it("reads a drop on the strip as a reorder at that index", () => {
    expect(resolveDropTarget(140, 15, [pane("p")])).toEqual({
      kind: "reorder",
      paneId: "p",
      index: 1,
    });
  });

  it("reads a drop in the middle of the content as a move into that pane", () => {
    expect(resolveDropTarget(200, 200, [pane("p")])).toEqual({
      kind: "reorder",
      paneId: "p",
      index: 3,
    });
  });

  it("reads a drop near a content edge as a split", () => {
    expect(resolveDropTarget(390, 200, [pane("p")])).toEqual({
      kind: "split",
      paneId: "p",
      edge: "right",
    });
  });

  it("prefers a strip over a content area when both could match", () => {
    const overlapping: PaneDropGeometry = {
      ...pane("p"),
      // A pathological pane whose content claims the strip's rows too.
      content: rect(0, 0, 400, 400),
    };
    expect(resolveDropTarget(140, 15, [overlapping])).toEqual({
      kind: "reorder",
      paneId: "p",
      index: 1,
    });
  });

  it("picks the pane the pointer is actually over when several exist", () => {
    const panes = [pane("left"), pane("right", 400)];
    expect(resolveDropTarget(540, 15, panes)).toEqual({
      kind: "reorder",
      paneId: "right",
      index: 1,
    });
  });

  it("returns null outside every pane", () => {
    expect(resolveDropTarget(2000, 2000, [pane("p")])).toBeNull();
  });
});

describe("sameTarget", () => {
  it("compares nulls and kinds", () => {
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, { kind: "reorder", paneId: "p", index: 0 })).toBe(false);
    expect(
      sameTarget(
        { kind: "reorder", paneId: "p", index: 0 },
        { kind: "split", paneId: "p", edge: "left" },
      ),
    ).toBe(false);
  });

  it("distinguishes indices and edges within a pane", () => {
    expect(
      sameTarget(
        { kind: "reorder", paneId: "p", index: 0 },
        { kind: "reorder", paneId: "p", index: 1 },
      ),
    ).toBe(false);
    expect(
      sameTarget(
        { kind: "split", paneId: "p", edge: "left" },
        { kind: "split", paneId: "p", edge: "left" },
      ),
    ).toBe(true);
  });
});
