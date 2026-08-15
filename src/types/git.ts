/** Mirrors `src-tauri/src/git.rs`'s `StatusKind` 1:1 — a file's staged and
 * unstaged status are tracked independently (a partially-staged file has
 * both), and a real merge conflict is its own variant, never collapsed
 * into `modified`. */
export type StatusKind =
  | { kind: "modified" }
  | { kind: "added" }
  | { kind: "deleted" }
  | { kind: "typeChanged" }
  | { kind: "renamed"; similarity: number }
  | { kind: "copied"; similarity: number }
  | { kind: "untracked" }
  | { kind: "conflicted"; ours: string; theirs: string };

export interface FileStatusEntry {
  path: string;
  /** Present only for `renamed`/`copied` staged entries. */
  oldPath?: string;
  staged?: StatusKind;
  unstaged?: StatusKind;
}

export interface WorkingStatus {
  ahead: number;
  behind: number;
  entries: FileStatusEntry[];
}

export type ScmEvent = { type: "statusChanged"; status: WorkingStatus };

export type DiffMode = "unstaged" | "staged" | "commit";

export type DiffContent =
  | {
      kind: "text";
      oldText: string;
      newText: string;
      oldLabel: string;
      newLabel: string;
      added: number;
      removed: number;
    }
  | { kind: "binary"; oldSize: number | null; newSize: number | null }
  | { kind: "directory" };

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  /** RFC3339. */
  timestamp: string;
  message: string;
}

/** `(path, kind)` tuples, matching the Rust command's `Vec<(String,
 * StatusKind)>` return shape (serde serializes tuples as 2-element
 * arrays) — one file's status entry within a single commit's change set. */
export type CommitFileEntry = [string, StatusKind];
