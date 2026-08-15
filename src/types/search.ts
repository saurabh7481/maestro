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
  | { type: "match"; file: FileMatches }
  | { type: "done"; filesMatched: number; cancelled: boolean };

export interface ReplaceSummary {
  filesChanged: number;
  replacementCount: number;
}
