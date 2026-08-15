import { invoke } from "@tauri-apps/api/core";
import type { ReplaceSummary, SearchOptions } from "../types/search";

/** Thin, typed wrapper around the search-related Tauri command surface —
 * same pattern as `fsApi`/`gitApi`. */
export const searchApi = {
  listFiles: (worktreeRoot: string) => invoke<string[]>("list_files", { worktreeRoot }),
  searchInFiles: (searchId: string, worktreeRoot: string, query: string, options: SearchOptions) =>
    invoke<void>("search_in_files", { searchId, worktreeRoot, query, options }),
  cancelSearch: (searchId: string) => invoke<void>("cancel_search", { searchId }),
  replaceInFiles: (
    worktreeRoot: string,
    query: string,
    replacement: string,
    options: SearchOptions,
    files: string[],
  ) =>
    invoke<ReplaceSummary>("replace_in_files", {
      worktreeRoot,
      query,
      replacement,
      options,
      files,
    }),
};
