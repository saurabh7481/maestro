import { create } from "zustand";

export type MarkdownMode = "source" | "preview";

export interface OpenFileMeta {
  dirty: boolean;
  diskMtimeMs: number;
  externalChangePending: boolean;
  markdownMode: MarkdownMode;
}

const DEFAULT_META: OpenFileMeta = {
  dirty: false,
  diskMtimeMs: 0,
  externalChangePending: false,
  markdownMode: "preview",
};

interface OpenFilesState {
  byTabId: Record<string, OpenFileMeta>;

  registerLoaded: (tabId: string, diskMtimeMs: number) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
  registerSaved: (tabId: string, diskMtimeMs: number) => void;
  setExternalChangePending: (tabId: string, pending: boolean) => void;
  /** "Keep mine": adopts the disk's current mtime as the new baseline
   * without touching `dirty` or the buffer content — so the next save
   * overwrites the external change instead of hitting a stale conflict. */
  acknowledgeExternalChange: (tabId: string, newDiskMtimeMs: number) => void;
  setMarkdownMode: (tabId: string, mode: MarkdownMode) => void;
  forget: (tabId: string) => void;
}

/** Per-tab file-buffer metadata (dirty flag, on-disk mtime, external-change
 * banner state, markdown source/preview mode) — kept separate from
 * `tabsStore` since the actual buffer content lives in Monaco's own
 * (non-serializable) text models, see `src/editor/monacoModelRegistry.ts`. */
export const useOpenFilesStore = create<OpenFilesState>((set) => ({
  byTabId: {},

  registerLoaded: (tabId, diskMtimeMs) =>
    set((s) => ({
      byTabId: {
        ...s.byTabId,
        [tabId]: { ...DEFAULT_META, ...s.byTabId[tabId], diskMtimeMs, dirty: false },
      },
    })),

  setDirty: (tabId, dirty) =>
    set((s) => ({
      byTabId: {
        ...s.byTabId,
        [tabId]: { ...DEFAULT_META, ...s.byTabId[tabId], dirty },
      },
    })),

  registerSaved: (tabId, diskMtimeMs) =>
    set((s) => ({
      byTabId: {
        ...s.byTabId,
        [tabId]: {
          ...DEFAULT_META,
          ...s.byTabId[tabId],
          diskMtimeMs,
          dirty: false,
          externalChangePending: false,
        },
      },
    })),

  setExternalChangePending: (tabId, pending) =>
    set((s) => ({
      byTabId: {
        ...s.byTabId,
        [tabId]: { ...DEFAULT_META, ...s.byTabId[tabId], externalChangePending: pending },
      },
    })),

  acknowledgeExternalChange: (tabId, newDiskMtimeMs) =>
    set((s) => ({
      byTabId: {
        ...s.byTabId,
        [tabId]: {
          ...DEFAULT_META,
          ...s.byTabId[tabId],
          diskMtimeMs: newDiskMtimeMs,
          externalChangePending: false,
        },
      },
    })),

  setMarkdownMode: (tabId, mode) =>
    set((s) => ({
      byTabId: {
        ...s.byTabId,
        [tabId]: { ...DEFAULT_META, ...s.byTabId[tabId], markdownMode: mode },
      },
    })),

  forget: (tabId) =>
    set((s) => {
      const byTabId = { ...s.byTabId };
      delete byTabId[tabId];
      return { byTabId };
    }),
}));

export function useIsTabDirty(tabId: string | undefined): boolean {
  return useOpenFilesStore((s) => (tabId ? (s.byTabId[tabId]?.dirty ?? false) : false));
}

export function useAnyDirtyTabs(): boolean {
  return useOpenFilesStore((s) => Object.values(s.byTabId).some((m) => m.dirty));
}
