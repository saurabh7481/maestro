import { Fragment, useRef, useState } from "react";
import { useTabsStore } from "../../state/tabsStore";
import type { LayoutNode, PaneSplit } from "../../state/paneLayout";
import { PaneView } from "./PaneView";
import styles from "./PaneGroup.module.css";

/** Smallest a pane may be dragged to, as a fraction of its split. Below
 * roughly this, a pane's tab strip stops being readable and the split
 * stops being useful — dragging past it clamps rather than collapsing the
 * pane, since collapsing is what closing its tabs is for. */
const MIN_FRACTION = 0.12;

/** Renders one worktree's pane tree (docs/V2_ROADMAP.md Phase 13).
 * `flexGrow` carries the fractional sizes rather than percentage widths,
 * so the splitters' fixed pixel widths come out of the container before
 * the panes divide what's left — with percentages, three panes plus two
 * splitters would overflow by exactly the splitters' width. */
export function PaneGroup({ node, worktreeKey }: { node: LayoutNode; worktreeKey: string }) {
  if (node.kind === "leaf") return <PaneView paneId={node.paneId} />;
  return <SplitGroup node={node} worktreeKey={worktreeKey} />;
}

function SplitGroup({ node, worktreeKey }: { node: PaneSplit; worktreeKey: string }) {
  const setPaneSizes = useTabsStore((s) => s.setPaneSizes);
  const containerRef = useRef<HTMLDivElement>(null);
  // Sizes are held locally for the duration of a drag and committed once
  // on release: writing every pointer move to the store would re-render
  // (and re-layout Monaco, and refit xterm in) every pane on every frame.
  const [dragSizes, setDragSizes] = useState<number[] | null>(null);
  const sizes = dragSizes ?? node.sizes;

  function beginResize(index: number, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const rect = container.getBoundingClientRect();
    const total = node.direction === "row" ? rect.width : rect.height;
    if (total <= 0) return;
    const origin = node.direction === "row" ? event.clientX : event.clientY;
    const start = [...node.sizes];
    // Only the two panes either side of this handle change; everything
    // else in the split holds still, which is what makes dragging one
    // divider feel local rather than reflowing the whole row.
    const pairTotal = start[index] + start[index + 1];
    let latest = start;

    function onMove(moveEvent: PointerEvent) {
      const position = node.direction === "row" ? moveEvent.clientX : moveEvent.clientY;
      const delta = (position - origin) / total;
      const before = Math.min(
        Math.max(start[index] + delta, MIN_FRACTION),
        pairTotal - MIN_FRACTION,
      );
      const next = [...start];
      next[index] = before;
      next[index + 1] = pairTotal - before;
      latest = next;
      setDragSizes(next);
    }

    function finish(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      if (handle.hasPointerCapture(upEvent.pointerId)) {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      setDragSizes(null);
      setPaneSizes(worktreeKey, node.id, latest);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
  }

  return (
    <div className={styles.split} data-direction={node.direction} ref={containerRef}>
      {node.children.map((child, index) => (
        <Fragment key={child.kind === "leaf" ? child.paneId : child.id}>
          {index > 0 && (
            <div
              className={styles.handle}
              data-direction={node.direction}
              role="separator"
              aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
              aria-label="Resize panes"
              onPointerDown={(event) => beginResize(index - 1, event)}
            />
          )}
          <div className={styles.cell} style={{ flexGrow: sizes[index] ?? 1 }}>
            <PaneGroup node={child} worktreeKey={worktreeKey} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
