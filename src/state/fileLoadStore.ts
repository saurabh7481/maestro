import { create } from "zustand";

export type FileLoadState =
  | { kind: "loading" }
  | { kind: "text" }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "tooLarge"; sizeBytes: number }
  | { kind: "error"; message: string };

interface FileLoadStoreState {
  byTabId: Record<string, FileLoadState>;
  setState: (tabId: string, state: FileLoadState) => void;
  forget: (tabId: string) => void;
}

/** What kind of viewer a file/markdown-source tab should render — text
 * (Monaco owns it), binary/too-large (a placeholder pane), loading, or
 * error. Separate from `openFilesStore` (dirty/mtime bookkeeping, which
 * only applies once a file is confirmed text and loaded into Monaco). */
export const useFileLoadStore = create<FileLoadStoreState>((set) => ({
  byTabId: {},
  setState: (tabId, state) => set((s) => ({ byTabId: { ...s.byTabId, [tabId]: state } })),
  forget: (tabId) =>
    set((s) => {
      const byTabId = { ...s.byTabId };
      delete byTabId[tabId];
      return { byTabId };
    }),
}));
