import { create } from "zustand";
import { sameTarget, type DropTarget } from "../components/chrome/tabDrag";
import type { TabType } from "./tabsStore";

/** The live tab drag, shared by the pieces that have to react to it: the
 * strip that draws the insertion caret, the pane that draws the split
 * preview, and the ghost that follows the pointer. Held in a store rather
 * than passed down because the drag routinely crosses pane boundaries —
 * the component the pointer is over is not the one the drag started in. */
interface DragSubject {
  tabId: string;
  title: string;
  type: TabType;
  fromPaneId: string;
}

interface TabDragState {
  subject: DragSubject | null;
  /** Viewport coordinates, updated on every pointer move while dragging. */
  x: number;
  y: number;
  target: DropTarget | null;

  begin: (subject: DragSubject, x: number, y: number) => void;
  move: (x: number, y: number, target: DropTarget | null) => void;
  end: () => void;
}

export const useTabDragStore = create<TabDragState>((set) => ({
  subject: null,
  x: 0,
  y: 0,
  target: null,

  begin: (subject, x, y) => set({ subject, x, y, target: null }),
  // Keeps the previous `target` object when the drop hasn't actually
  // moved: components select `target` by reference, and handing them a
  // fresh-but-equal object on every pointer move would re-render every
  // pane sixty times a second for nothing.
  move: (x, y, target) =>
    set((s) => ({ x, y, target: sameTarget(s.target, target) ? s.target : target })),
  end: () => set({ subject: null, target: null }),
}));
