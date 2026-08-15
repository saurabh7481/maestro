import type { FileMatches, SearchMatch } from "../../types/search";

/** One flat, virtualizable row list. Results used to render as nested
 * `results.map(file => file.matches.map(...))`, so a query matching a few
 * thousand times built a DOM row per match — unbounded, and paid in full
 * whether or not any of it was scrolled to (docs/PERFORMANCE_AUDIT.md
 * §2.3). Flattening is what makes a single virtualizer possible across
 * both row types. */
export type ResultRow =
  | { kind: "file"; key: string; file: FileMatches; collapsed: boolean }
  | { kind: "match"; key: string; file: FileMatches; match: SearchMatch };

export function flattenResults(results: FileMatches[], collapsedFiles: Set<string>): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const file of results) {
    const collapsed = collapsedFiles.has(file.path);
    rows.push({ kind: "file", key: file.path, file, collapsed });
    if (collapsed) continue;
    file.matches.forEach((match, i) => {
      rows.push({
        kind: "match",
        key: `${file.path}:${match.line}:${i}`,
        file,
        match,
      });
    });
  }
  return rows;
}
