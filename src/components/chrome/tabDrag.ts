import type { SplitEdge } from "../../state/paneLayout";

/** Geometry and hit-testing for tab dragging (docs/V2_ROADMAP.md Phase
 * 13). Kept separate from the components so the part with actual rules in
 * it — where a drop lands, given a pointer and a set of panes — is a pure
 * function with tests, rather than something only reachable by dragging
 * with a mouse.
 *
 * Pointer events, not HTML5 drag-and-drop: the tab strip has to show a
 * live insertion caret and edge-split overlays, and the drag image needs
 * to look like a Maestro tab rather than a WebKitGTK screenshot of one.
 * HTML5 DnD gives up control of all three. */

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PaneDropGeometry {
  paneId: string;
  /** The tab strip's bounds, where a drop means "reorder/insert here". */
  strip: RectLike;
  /** The pane's content area, where a drop near an edge means "split". */
  content: RectLike;
  /** Each tab's horizontal extent within the strip, in strip order. */
  tabs: { id: string; left: number; right: number }[];
}

export type DropTarget =
  | { kind: "reorder"; paneId: string; index: number }
  | { kind: "split"; paneId: string; edge: SplitEdge };

/** How much of a pane's content counts as its split zone. A quarter is
 * generous enough to hit without aiming, and still leaves a clear middle
 * that means "just move the tab into this pane". */
export const EDGE_RATIO = 0.25;

/** Pixels the pointer must travel before a press becomes a drag — below
 * this, a press-and-release is just a click that selects the tab. */
export const DRAG_THRESHOLD_PX = 5;

function contains(rect: RectLike, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** The insertion index for a pointer at `x` over a strip: the number of
 * tabs whose midpoint it has passed. Dropping on the left half of the
 * third tab inserts *before* it, which is what the caret drawn between
 * tabs promises. */
export function insertionIndex(tabs: PaneDropGeometry["tabs"], x: number): number {
  let index = 0;
  for (const tab of tabs) {
    if (x > (tab.left + tab.right) / 2) index += 1;
  }
  return index;
}

/** Which edge zone (if any) a point falls in, as a fraction of the rect's
 * own size — so a narrow pane's edge zone is narrow too, and a drop in
 * the middle of even a small pane still reads as "move here". */
export function edgeAt(rect: RectLike, x: number, y: number, ratio = EDGE_RATIO): SplitEdge | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const distances: { edge: SplitEdge; fraction: number }[] = [
    { edge: "left", fraction: (x - rect.left) / rect.width },
    { edge: "right", fraction: (rect.right - x) / rect.width },
    { edge: "top", fraction: (y - rect.top) / rect.height },
    { edge: "bottom", fraction: (rect.bottom - y) / rect.height },
  ];
  const nearest = distances.reduce((best, candidate) =>
    candidate.fraction < best.fraction ? candidate : best,
  );
  return nearest.fraction <= ratio ? nearest.edge : null;
}

/** Resolves a pointer position to a drop. Strips win over content areas
 * when both contain the point (a strip sits inside its pane's bounds),
 * because a drop on a strip is always an explicit "put it here, in this
 * order" and should never be reinterpreted as a split. */
export function resolveDropTarget(
  x: number,
  y: number,
  geometries: PaneDropGeometry[],
  ratio = EDGE_RATIO,
): DropTarget | null {
  for (const geometry of geometries) {
    if (contains(geometry.strip, x, y)) {
      return { kind: "reorder", paneId: geometry.paneId, index: insertionIndex(geometry.tabs, x) };
    }
  }
  for (const geometry of geometries) {
    if (!contains(geometry.content, x, y)) continue;
    const edge = edgeAt(geometry.content, x, y, ratio);
    return edge
      ? { kind: "split", paneId: geometry.paneId, edge }
      : { kind: "reorder", paneId: geometry.paneId, index: geometry.tabs.length };
  }
  return null;
}

export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.paneId !== b.paneId) return false;
  return a.kind === "reorder" && b.kind === "reorder"
    ? a.index === b.index
    : a.kind === "split" && b.kind === "split" && a.edge === b.edge;
}

/** Live DOM registry, deliberately not React state: it changes on every
 * pane mount and is only ever read at drag time, so putting it in a store
 * would re-render the whole editor area for information nothing renders. */
interface PaneElements {
  strip?: HTMLElement;
  content?: HTMLElement;
}

const paneElements = new Map<string, PaneElements>();

export function registerPaneElement(
  paneId: string,
  role: keyof PaneElements,
  element: HTMLElement | null,
): void {
  const entry = paneElements.get(paneId) ?? {};
  if (element) entry[role] = element;
  else delete entry[role];
  if (entry.strip || entry.content) paneElements.set(paneId, entry);
  else paneElements.delete(paneId);
}

/** Measures every registered pane once, at drag start and on each move —
 * `getBoundingClientRect` is cheap for a handful of elements and always
 * current, which matters because a split created mid-drag changes every
 * other pane's geometry. */
export function measurePanes(): PaneDropGeometry[] {
  const geometries: PaneDropGeometry[] = [];
  for (const [paneId, elements] of paneElements) {
    if (!elements.strip || !elements.content) continue;
    const tabs = Array.from(elements.strip.querySelectorAll<HTMLElement>("[data-tab-id]")).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.dataset.tabId ?? "", left: rect.left, right: rect.right };
      },
    );
    geometries.push({
      paneId,
      strip: elements.strip.getBoundingClientRect(),
      content: elements.content.getBoundingClientRect(),
      tabs,
    });
  }
  return geometries;
}
