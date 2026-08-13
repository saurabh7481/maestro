import { create } from "zustand";

export type CloseIntent = "close-tab" | "quit";

interface CloseConfirmState {
  pendingTabIds: string[] | null;
  intent: CloseIntent | null;
  request: (tabIds: string[], intent: CloseIntent) => void;
  clear: () => void;
}

/** Drives `UnsavedChangesDialog` (rendered once, globally, in AppShell) —
 * both the per-tab close guard (TabStrip) and the whole-window quit guard
 * (AppShell's `onCloseRequested` listener) funnel through this instead of
 * each owning their own dialog state. */
export const useCloseConfirmStore = create<CloseConfirmState>((set) => ({
  pendingTabIds: null,
  intent: null,
  request: (tabIds, intent) => set({ pendingTabIds: tabIds, intent }),
  clear: () => set({ pendingTabIds: null, intent: null }),
}));
