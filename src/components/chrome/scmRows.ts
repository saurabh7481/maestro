import type { FileStatusEntry } from "../../types/git";

export type ScmRow =
  | { kind: "header"; key: string; section: ScmSection }
  | { kind: "file"; key: string; section: ScmSection; entry: FileStatusEntry };

export type ScmSection = "conflicted" | "staged" | "changes";

export interface ScmSections {
  conflicted: FileStatusEntry[];
  staged: FileStatusEntry[];
  changes: FileStatusEntry[];
}

/** Splits a `WorkingStatus`'s flat entry list into the three displayed
 * sections. A file with both staged and unstaged changes legitimately
 * appears in two of them. */
export function splitScmSections(entries: FileStatusEntry[]): ScmSections {
  return {
    conflicted: entries.filter((e) => e.staged?.kind === "conflicted"),
    staged: entries.filter((e) => e.staged && e.staged.kind !== "conflicted"),
    changes: entries.filter((e) => e.unstaged),
  };
}

/** Section headers and file rows flattened into one list so a single
 * virtualizer spans all three sections. The Conflicted header only appears
 * when there is something conflicted; the other two always show, since
 * their headers carry the stage-all/unstage-all affordances and the counts. */
export function flattenScmRows(
  sections: ScmSections,
  collapsed: Record<ScmSection, boolean>,
): ScmRow[] {
  const rows: ScmRow[] = [];
  const pushSection = (section: ScmSection, entries: FileStatusEntry[], keyPrefix: string) => {
    rows.push({ kind: "header", key: `h:${section}`, section });
    if (collapsed[section]) return;
    for (const entry of entries) {
      rows.push({ kind: "file", key: `${keyPrefix}:${entry.path}`, section, entry });
    }
  };

  if (sections.conflicted.length > 0) {
    pushSection("conflicted", sections.conflicted, "conflict");
  }
  pushSection("staged", sections.staged, "staged");
  pushSection("changes", sections.changes, "changes");
  return rows;
}
