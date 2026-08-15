import { useCallback, useRef } from "react";
import { useTabDragStore } from "../../state/tabDragStore";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { DRAG_THRESHOLD_PX, measurePanes, resolveDropTarget, type DropTarget } from "./tabDrag";

/** Turns a pointer press on a tab into either a plain click (select the
 * tab) or a drag (reorder / move to another pane / split). One
 * `pointerdown` handler covers both, so a tab stays clickable without a
 * separate drag handle.
 *
 * Pointer capture on the tab element means the drag keeps receiving
 * events even once the pointer leaves the tab — including over a
 * different pane entirely, which is the whole point. */
export function useTabDrag(tab: Tab, paneId: string) {
  const begin = useTabDragStore((s) => s.begin);
  const move = useTabDragStore((s) => s.move);
  const end = useTabDragStore((s) => s.end);
  const started = useRef(false);

  return useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Left button only: middle-click closes a tab and right-click opens
      // the context menu, neither of which should start a drag.
      if (event.button !== 0) return;
      const element = event.currentTarget;
      const originX = event.clientX;
      const originY = event.clientY;
      started.current = false;

      function onMove(moveEvent: PointerEvent) {
        if (!started.current) {
          const travelled = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
          if (travelled < DRAG_THRESHOLD_PX) return;
          started.current = true;
          element.setPointerCapture(moveEvent.pointerId);
          begin(
            { tabId: tab.id, title: tab.title, type: tab.type, fromPaneId: paneId },
            moveEvent.clientX,
            moveEvent.clientY,
          );
        }
        // Re-measuring on every move is deliberate: a split created
        // mid-drag changes every other pane's geometry, so cached rects
        // would aim the drop at where a pane used to be. `move` keeps the
        // previous target object when the drop hasn't changed, so this
        // doesn't re-render the panes on every frame.
        const target = resolveDropTarget(moveEvent.clientX, moveEvent.clientY, measurePanes());
        move(moveEvent.clientX, moveEvent.clientY, target);
      }

      function finish(upEvent: PointerEvent) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        if (!started.current) return;
        if (element.hasPointerCapture(upEvent.pointerId)) {
          element.releasePointerCapture(upEvent.pointerId);
        }
        const target = useTabDragStore.getState().target;
        end();
        if (target) applyDrop(tab.id, target);
      }

      function cancel() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        end();
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    },
    [tab.id, tab.title, tab.type, paneId, begin, move, end],
  );
}

/** Commits a finished drag. Separated from the event plumbing so the
 * "what does this drop mean" decision is one readable block.
 *
 * A split whose source pane holds only the dragged tab is a no-op —
 * `splitPane` declines it rather than creating a pane that would collapse
 * again on the same frame. */
function applyDrop(tabId: string, target: DropTarget): void {
  const store = useTabsStore.getState();
  if (target.kind === "split") {
    store.splitPane(target.paneId, target.edge, tabId);
  } else {
    store.moveTab(tabId, target.paneId, target.index);
  }
}
