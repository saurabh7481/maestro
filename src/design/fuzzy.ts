/** Minimal in-order subsequence fuzzy match — good enough for a short,
 * static command list without pulling in a fuzzy-search dependency. */
export function fuzzyMatch(query: string, target: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Scored variant of `fuzzyMatch`, for ranking a potentially large list
 * (quick-open's worktree file list) rather than just filtering a short
 * static command list. Rewards contiguous runs and matches starting right
 * after a path boundary ("/") — a simple heuristic, not a full
 * fuzzy-search engine, since quick-open only needs "good enough" ordering
 * over a few hundred/thousand paths. Returns `null` for no match. */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0;
  let score = 0;
  let runLength = 0;
  let prevMatchIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    const isContiguous = prevMatchIndex === ti - 1;
    runLength = isContiguous ? runLength + 1 : 1;
    score += 1 + runLength;
    if (ti === 0 || t[ti - 1] === "/") score += 10;
    prevMatchIndex = ti;
    qi++;
  }

  if (qi !== q.length) return null;
  // Among equally-good matches, a shorter target ranks slightly higher
  // (favors "Foo.ts" over "Foo/Bar/Baz.ts" for the same query "foo").
  return score - target.length * 0.01;
}
