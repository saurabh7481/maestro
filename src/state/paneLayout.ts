/** The pane-layout tree behind multi-pane editing (docs/V2_ROADMAP.md
 * Phase 13), kept as pure functions so the tree algebra — which is where
 * split/close bugs actually live — is testable without a store, a React
 * tree, or a DOM.
 *
 * The shape is VS Code's: a leaf is one pane (its own tab strip and
 * content area), a split is a row or column of children with fractional
 * sizes. Two invariants every function here preserves, because the
 * renderer and the store both rely on them:
 *
 *   1. A split always has at least two children — a one-child split is
 *      collapsed into that child.
 *   2. `sizes` has exactly one entry per child and sums to 1.
 */

export interface PaneLeaf {
  kind: "leaf";
  paneId: string;
}

export interface PaneSplit {
  kind: "split";
  /** Split nodes carry an id purely so a resize can address one directly
   * (`updateSizes`) instead of the renderer having to thread a positional
   * path down through every level. */
  id: string;
  direction: "row" | "column";
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = PaneLeaf | PaneSplit;

export type SplitEdge = "left" | "right" | "top" | "bottom";

export function leaf(paneId: string): PaneLeaf {
  return { kind: "leaf", paneId };
}

export function collectPaneIds(node: LayoutNode): string[] {
  return node.kind === "leaf" ? [node.paneId] : node.children.flatMap(collectPaneIds);
}

export function containsPane(node: LayoutNode, paneId: string): boolean {
  return node.kind === "leaf"
    ? node.paneId === paneId
    : node.children.some((child) => containsPane(child, paneId));
}

export function paneCount(node: LayoutNode): number {
  return collectPaneIds(node).length;
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((size) => size / total);
}

/** Which axis an edge splits along, and whether the new pane lands before
 * the existing one. */
export function edgeToSplit(edge: SplitEdge): { direction: "row" | "column"; before: boolean } {
  switch (edge) {
    case "left":
      return { direction: "row", before: true };
    case "right":
      return { direction: "row", before: false };
    case "top":
      return { direction: "column", before: true };
    case "bottom":
      return { direction: "column", before: false };
  }
}

/** Inserts `newPaneId` next to `targetPaneId`.
 *
 * When the target already sits in a split running the requested
 * direction, the new pane joins that split as a sibling and takes half of
 * the target's share — so splitting right twice gives three even-ish
 * columns rather than a right-heavy nest of two-column splits. Otherwise
 * the target leaf is replaced by a fresh split holding both. */
export function insertBeside(
  root: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: "row" | "column",
  before: boolean,
  splitId: string,
): LayoutNode {
  function visit(node: LayoutNode): LayoutNode {
    if (node.kind === "leaf") {
      if (node.paneId !== targetPaneId) return node;
      const pair = before ? [leaf(newPaneId), node] : [node, leaf(newPaneId)];
      return { kind: "split", id: splitId, direction, children: pair, sizes: [0.5, 0.5] };
    }

    const index = node.children.findIndex(
      (child) => child.kind === "leaf" && child.paneId === targetPaneId,
    );
    if (index === -1 || node.direction !== direction) {
      return { ...node, children: node.children.map(visit) };
    }

    const share = node.sizes[index] ?? 1 / node.children.length;
    const children = [...node.children];
    const sizes = [...node.sizes];
    children.splice(before ? index : index + 1, 0, leaf(newPaneId));
    sizes.splice(before ? index : index + 1, 0, share / 2);
    sizes[before ? index + 1 : index] = share / 2;
    return { ...node, children, sizes: normalize(sizes) };
  }

  return visit(root);
}

/** Removes a pane, collapsing any split left with a single child. Returns
 * `null` when the removed pane was the last one — the caller decides what
 * an empty layout means (the store creates a fresh empty pane, so a
 * worktree always has somewhere to open the next tab). */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.kind === "leaf") return root.paneId === paneId ? null : root;

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, index) => {
    const next = removePane(child, paneId);
    if (next === null) return;
    children.push(next);
    sizes.push(root.sizes[index] ?? 1 / root.children.length);
  });

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...root, children, sizes: normalize(sizes) };
}

/** Replaces one split's child sizes — what a splitter drag commits. Sizes
 * are normalized here so a caller doing pixel math never has to. */
export function updateSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.kind === "leaf") return root;
  if (root.id === splitId && sizes.length === root.children.length) {
    return { ...root, sizes: normalize(sizes) };
  }
  return { ...root, children: root.children.map((child) => updateSizes(child, splitId, sizes)) };
}

/** Left-to-right, top-to-bottom pane order — what "focus the next pane"
 * and layout persistence both mean by "in order". */
export function paneOrder(root: LayoutNode): string[] {
  return collectPaneIds(root);
}

/** Guards a layout restored from disk (or handed over from another
 * window) against pane ids that no longer exist, and against the
 * structural invariants above being violated by a hand-edited or
 * partially-written file. Returns `null` if nothing usable survives. */
export function pruneLayout(node: LayoutNode, knownPaneIds: Set<string>): LayoutNode | null {
  if (node.kind === "leaf") return knownPaneIds.has(node.paneId) ? node : null;

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const pruned = pruneLayout(child, knownPaneIds);
    if (!pruned) return;
    children.push(pruned);
    sizes.push(node.sizes[index] ?? 1 / node.children.length);
  });

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normalize(sizes) };
}
