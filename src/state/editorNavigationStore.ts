import { create } from "zustand";
import type * as monaco from "monaco-editor";

interface PendingNavigation {
  tabId: string;
  selection?: monaco.IRange | monaco.IPosition;
}

interface EditorNavigationState {
  pending: PendingNavigation | null;
  request: (pending: PendingNavigation) => void;
  consume: (tabId: string) => PendingNavigation | null;
}

export const useEditorNavigationStore = create<EditorNavigationState>((set, get) => ({
  pending: null,
  request: (pending) => set({ pending }),
  consume: (tabId) => {
    const pending = get().pending;
    if (pending?.tabId !== tabId) return null;
    set({ pending: null });
    return pending;
  },
}));
