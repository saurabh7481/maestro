import { describe, expect, it } from "vitest";
import { flattenResults } from "./resultRows";
import type { FileMatches } from "../../types/search";

function file(path: string, lines: number[]): FileMatches {
  return {
    path,
    matches: lines.map((line) => ({
      line,
      matchStart: 0,
      matchEnd: 1,
      lineText: `line ${line}`,
    })),
  };
}

describe("flattenResults", () => {
  it("emits a header row per file followed by its match rows, in order", () => {
    const rows = flattenResults([file("a.ts", [1, 2]), file("b.ts", [9])], new Set());
    expect(
      rows.map((r) => (r.kind === "file" ? `#${r.file.path}` : `${r.file.path}:${r.match.line}`)),
    ).toEqual(["#a.ts", "a.ts:1", "a.ts:2", "#b.ts", "b.ts:9"]);
  });

  it("keeps a collapsed file's header but drops its match rows", () => {
    const rows = flattenResults([file("a.ts", [1, 2]), file("b.ts", [9])], new Set(["a.ts"]));
    expect(rows.map((r) => r.key)).toEqual(["a.ts", "b.ts", "b.ts:9:0"]);
  });

  it("marks collapsed state on the file row", () => {
    const rows = flattenResults([file("a.ts", [1])], new Set(["a.ts"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === "file" && rows[0].collapsed).toBe(true);
  });

  it("gives every row a unique key, including repeated matches on one line", () => {
    // Two matches on the same line share `path` and `line`; without the
    // index in the key the virtualizer would see duplicate keys.
    const rows = flattenResults([file("a.ts", [3, 3])], new Set());
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns nothing for no results", () => {
    expect(flattenResults([], new Set())).toEqual([]);
  });
});
