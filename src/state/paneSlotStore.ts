import { create } from "zustand";

/** Where each pane's content area actually is in the DOM.
 *
 * `TabHost` keeps agent and terminal tabs mounted for as long as they're
 * open (docs/PERFORMANCE_AUDIT.md §1.2) — that has to keep working now
 * that several tabs are visible at once in different panes. Rather than
 * moving those components into the pane tree (where a pane collapsing or
 * a tab moving would unmount them, throwing away an xterm buffer and a
 * whole agent transcript), `TabHost` stays mounted once at the shell
 * level and portals each tab into the pane that currently owns it. Panes
 * register their content element here on mount; the portal target is
 * whatever element is registered for the tab's pane at render time. */
interface PaneSlotState {
  slots: Record<string, HTMLElement>;
  register: (paneId: string, element: HTMLElement) => void;
  unregister: (paneId: string) => void;
}

export const usePaneSlotStore = create<PaneSlotState>((set) => ({
  slots: {},
  register: (paneId, element) => set((s) => ({ slots: { ...s.slots, [paneId]: element } })),
  unregister: (paneId) =>
    set((s) => {
      if (!s.slots[paneId]) return s;
      const slots = { ...s.slots };
      delete slots[paneId];
      return { slots };
    }),
}));
