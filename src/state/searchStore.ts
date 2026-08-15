import { create } from "zustand";
import { searchApi } from "../api/search";
import { listenToSearchEvents } from "../api/searchEvents";
import { fsApi } from "../api/fs";
import { getModel } from "../editor/monacoModelRegistry";
import { useTabsStore, fileTabId } from "./tabsStore";
import { useOpenFilesStore } from "./openFilesStore";
import type { FileMatches, SearchMatch, SearchOptions } from "../types/search";

export type SearchStatus = "idle" | "searching" | "done";

export interface PendingReveal {
  tabId: string;
  line: number;
  matchStart: number;
  matchEnd: number;
}

function isMarkdownPath(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

interface SearchState {
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  replaceOpen: boolean;
  results: FileMatches[];
  status: SearchStatus;
  searchId: string | null;
  collapsedFiles: Set<string>;
  pendingReveal: PendingReveal | null;
  /** Non-null while a replace-all is blocked on user confirmation because
   * some matched files have unsaved edits — see `replaceAll`. */
  confirmDirtyFiles: string[] | null;

  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  setCaseSensitive: (value: boolean) => void;
  setWholeWord: (value: boolean) => void;
  setUseRegex: (value: boolean) => void;
  setReplaceOpen: (open: boolean) => void;
  toggleFileCollapsed: (path: string) => void;
  runSearch: (worktreeRoot: string) => void;
  cancelSearch: () => void;
  replaceAll: (worktreeId: string, worktreeRoot: string) => Promise<void>;
  confirmReplaceAll: (worktreeId: string, worktreeRoot: string) => Promise<void>;
  dismissConfirmDirty: () => void;
  reveal: (worktreeId: string, worktreeRoot: string, path: string, match: SearchMatch) => void;
  clearPendingReveal: () => void;
}

function currentOptions(
  s: Pick<SearchState, "caseSensitive" | "wholeWord" | "useRegex">,
): SearchOptions {
  return { caseSensitive: s.caseSensitive, wholeWord: s.wholeWord, useRegex: s.useRegex };
}

/** Backs the "Search" sidebar panel — file-content search across the
 * active worktree, plus replace/replace-all. Quick-open (⌘P, filename-only
 * fuzzy jump) is a separate, simpler flow owned by `CommandPalette.tsx`
 * directly; this store is only the content-search/replace half. */
export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  replaceOpen: false,
  results: [],
  status: "idle",
  searchId: null,
  collapsedFiles: new Set(),
  pendingReveal: null,
  confirmDirtyFiles: null,

  setQuery: (query) => set({ query }),
  setReplacement: (replacement) => set({ replacement }),
  setCaseSensitive: (caseSensitive) => set({ caseSensitive }),
  setWholeWord: (wholeWord) => set({ wholeWord }),
  setUseRegex: (useRegex) => set({ useRegex }),
  setReplaceOpen: (replaceOpen) => set({ replaceOpen }),
  toggleFileCollapsed: (path) =>
    set((s) => {
      const collapsedFiles = new Set(s.collapsedFiles);
      if (collapsedFiles.has(path)) collapsedFiles.delete(path);
      else collapsedFiles.add(path);
      return { collapsedFiles };
    }),

  runSearch: (worktreeRoot) => {
    const { query } = get();
    if (!query.trim()) {
      set({ results: [], status: "idle", searchId: null });
      return;
    }
    const searchId = crypto.randomUUID();
    set({ results: [], status: "searching", searchId });

    void listenToSearchEvents(searchId, (event) => {
      // A stale event from a search this store has since moved on from
      // (query changed again mid-flight) — ignore rather than mixing
      // result sets from two different queries.
      if (get().searchId !== searchId) return;
      if (event.type === "match") {
        set((s) => ({ results: [...s.results, event.file] }));
      } else {
        set({ status: "done" });
      }
    }).then((unlisten) => {
      // A newer search already won by the time the listener attached —
      // tear it down immediately instead of leaking it.
      if (get().searchId !== searchId) {
        unlisten();
        return;
      }
      void searchApi
        .searchInFiles(searchId, worktreeRoot, query, currentOptions(get()))
        .finally(unlisten);
    });
  },

  cancelSearch: () => {
    const { searchId } = get();
    if (searchId) void searchApi.cancelSearch(searchId);
  },

  replaceAll: async (worktreeId, worktreeRoot) => {
    const { results } = get();
    const files = results.map((r) => r.path);
    if (files.length === 0) return;

    const dirtyByTabId = useOpenFilesStore.getState().byTabId;
    const openTabs = useTabsStore.getState().tabs;
    const dirtyFiles = files.filter((relPath) => {
      const tabId = fileTabId(worktreeId, relPath);
      return openTabs.some((t) => t.id === tabId) && dirtyByTabId[tabId]?.dirty;
    });

    if (dirtyFiles.length > 0) {
      set({ confirmDirtyFiles: dirtyFiles });
      return;
    }
    await get().confirmReplaceAll(worktreeId, worktreeRoot);
  },

  confirmReplaceAll: async (worktreeId, worktreeRoot) => {
    set({ confirmDirtyFiles: null });
    const { query, replacement, results } = get();
    const files = results.map((r) => r.path);
    if (files.length === 0) return;

    await searchApi.replaceInFiles(worktreeRoot, query, replacement, currentOptions(get()), files);

    // Open-but-clean tabs get refreshed here directly instead of making
    // the user click the external-change banner's Reload for each one —
    // a *dirty* tab is deliberately left alone: its unsaved edits stay in
    // the buffer, and the on-disk change still surfaces through the
    // normal watcher-driven external-change banner if/when it's touched.
    const openTabs = useTabsStore.getState().tabs;
    const dirtyByTabId = useOpenFilesStore.getState().byTabId;
    const { registerLoaded } = useOpenFilesStore.getState();
    for (const relPath of files) {
      const tabId = fileTabId(worktreeId, relPath);
      const tab = openTabs.find((t) => t.id === tabId);
      if (!tab || dirtyByTabId[tabId]?.dirty) continue;
      const result = await fsApi.readFile(worktreeRoot, relPath);
      if (result.kind !== "text") continue;
      getModel(tabId)?.setValue(result.content);
      registerLoaded(tabId, result.mtimeMs);
    }

    // Refresh the results panel — a successful replace typically leaves
    // 0 (or fewer) remaining matches, and the user should see that
    // reflected rather than a now-stale result list.
    get().runSearch(worktreeRoot);
  },

  dismissConfirmDirty: () => set({ confirmDirtyFiles: null }),

  reveal: (worktreeId, worktreeRoot, path, match) => {
    const tabId = fileTabId(worktreeId, path);
    useTabsStore.getState().ensureTab({
      id: tabId,
      type: isMarkdownPath(path) ? "markdown" : "file",
      title: path.split("/").pop() ?? path,
      filePath: path,
      worktreeRoot,
    });
    set({
      pendingReveal: {
        tabId,
        line: match.line,
        matchStart: match.matchStart,
        matchEnd: match.matchEnd,
      },
    });
  },

  clearPendingReveal: () => set({ pendingReveal: null }),
}));
