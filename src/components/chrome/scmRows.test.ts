import { describe, expect, it } from "vitest";
import { flattenScmRows, splitScmSections } from "./scmRows";
import type { FileStatusEntry } from "../../types/git";

function entry(
  path: string,
  staged?: FileStatusEntry["staged"],
  unstaged?: FileStatusEntry["unstaged"],
): FileStatusEntry {
  return { path, staged, unstaged };
}

const modified = { kind: "modified" } as const;
const conflictedKind = { kind: "conflicted", ours: "U", theirs: "U" } as const;

const ALL_EXPANDED = { conflicted: false, staged: false, changes: false } as const;

describe("splitScmSections", () => {
  it("puts a file with both staged and unstaged changes in both sections", () => {
    const sections = splitScmSections([entry("a.ts", modified, modified)]);
    expect(sections.staged.map((e) => e.path)).toEqual(["a.ts"]);
    expect(sections.changes.map((e) => e.path)).toEqual(["a.ts"]);
    expect(sections.conflicted).toHaveLength(0);
  });

  it("keeps conflicted entries out of the staged section", () => {
    const sections = splitScmSections([entry("c.ts", conflictedKind)]);
    expect(sections.conflicted.map((e) => e.path)).toEqual(["c.ts"]);
    expect(sections.staged).toHaveLength(0);
  });
});

describe("flattenScmRows", () => {
  it("omits the Conflicted header when nothing is conflicted", () => {
    const rows = flattenScmRows(splitScmSections([entry("a.ts", modified)]), ALL_EXPANDED);
    expect(rows.filter((r) => r.kind === "header").map((r) => r.section)).toEqual([
      "staged",
      "changes",
    ]);
  });

  it("always shows the staged and changes headers, even when empty", () => {
    const rows = flattenScmRows(splitScmSections([]), ALL_EXPANDED);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "header")).toBe(true);
  });

  it("interleaves headers and their rows in section order", () => {
    const rows = flattenScmRows(
      splitScmSections([
        entry("c.ts", conflictedKind),
        entry("s.ts", modified),
        entry("u.ts", undefined, modified),
      ]),
      ALL_EXPANDED,
    );
    expect(rows.map((r) => (r.kind === "header" ? `#${r.section}` : r.entry.path))).toEqual([
      "#conflicted",
      "c.ts",
      "#staged",
      "s.ts",
      "#changes",
      "u.ts",
    ]);
  });

  it("drops a collapsed section's rows but keeps its header", () => {
    const sections = splitScmSections([
      entry("s.ts", modified),
      entry("u.ts", undefined, modified),
    ]);
    const rows = flattenScmRows(sections, { conflicted: false, staged: true, changes: false });
    expect(rows.map((r) => (r.kind === "header" ? `#${r.section}` : r.entry.path))).toEqual([
      "#staged",
      "#changes",
      "u.ts",
    ]);
  });

  it("gives a file appearing in two sections distinct keys", () => {
    // Virtualizer keys must be unique or React reuses the wrong row — the
    // staged/unstaged prefixes are what prevent that for a file that is in
    // both sections at once.
    const rows = flattenScmRows(
      splitScmSections([entry("a.ts", modified, modified)]),
      ALL_EXPANDED,
    );
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("staged:a.ts");
    expect(keys).toContain("changes:a.ts");
  });
});
