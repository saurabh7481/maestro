export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export interface SearchMatch {
  line: number;
  /** Byte offsets into `lineText` — see `search.rs::SearchMatch`'s
   * comment. Correct for ASCII lines; a match after multi-byte UTF-8 on
   * the same line may highlight a slightly wrong slice. */
  matchStart: number;
  matchEnd: number;
  lineText: string;
}

export interface FileMatches {
  path: string;
  matches: SearchMatch[];
}

export type SearchEvent =
  /** A batch of scanned files, in `git ls-files` order — the backend emits
   * one event per scan round rather than one per matching file
   * (docs/PERFORMANCE_AUDIT.md §2.4). */
  | { type: "match"; files: FileMatches[] }
  | {
      type: "done";
      filesMatched: number;
      cancelled: boolean;
      /** The scan stopped at the backend's matched-file ceiling with files
       * left unscanned; results are a prefix, not the whole set. */
      truncated: boolean;
    };

export interface ReplaceSummary {
  filesChanged: number;
  replacementCount: number;
}
