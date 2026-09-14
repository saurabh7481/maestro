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

/** Mirrors `src-tauri/src/git_remote.rs`'s `GitErrorCode`. The UI
 * switches on this for iconography and tone; the human-readable halves of
 * a `GitRemoteError` are never parsed. */
export type GitErrorCode =
  | "noRemote"
  | "noRemoteBranch"
  | "authFailed"
  | "hostKey"
  | "network"
  | "repositoryNotFound"
  | "dirtyWorkingTree"
  | "untrackedOverwrite"
  | "diverged"
  | "mergeConflict"
  | "rejected"
  | "hookRejected"
  | "operationInProgress"
  | "detachedHead"
  | "unbornBranch"
  | "forcePushStale"
  | "locked"
  | "timedOut"
  | "unknown";

/** A remedy the backend says applies to this failure, rendered as a
 * button. Mirrors `git_remote.rs`'s `GitErrorAction`. */
export type GitErrorAction =
  "stashAndPull" | "rebasePull" | "mergePull" | "pullThenPush" | "forcePush" | "retry";

/** The structured failure `push_changes`/`pull_changes`/`fetch_remote`
 * reject with — see `git_remote.rs`. `detail` is git's own output, kept
 * verbatim and shown only behind a disclosure. */
export interface GitRemoteError {
  code: GitErrorCode;
  title: string;
  message: string;
  detail: string;
  paths: string[];
  actions: GitErrorAction[];
}

/** How a pull reconciles local and remote history. Anything other than
 * the default is only ever chosen by the user picking a remedy off a
 * failed pull. */
export type PullStrategy = "fastForward" | "stashFastForward" | "rebase" | "merge";

export interface RemoteOutcome {
  /** One line, already phrased for display — "Pulled 198 commits from
   * origin/sayar", "Everything up to date on origin/main". */
  summary: string;
}

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

export interface BlameLine {
  /** 1-based, matching Monaco's own line numbering. */
  line: number;
  /** All-zero for a working-tree line with no commit yet. */
  hash: string;
  author: string;
  /** Unix seconds. */
  authorTime: number;
  summary: string;
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  /** RFC3339. */
  timestamp: string;
  message: string;
}

export interface ConflictContent {
  path: string;
  baseText: string;
  currentText: string;
  incomingText: string;
  resultText: string;
}

export interface StashEntry {
  index: number;
  reference: string;
  hash: string;
  message: string;
  timestamp: string;
}

export interface ReviewFile {
  path: string;
  kind: StatusKind;
  mode: DiffMode;
  commitHash?: string;
  added?: number;
  removed?: number;
}

/** `(path, kind)` tuples, matching the Rust command's `Vec<(String,
 * StatusKind)>` return shape (serde serializes tuples as 2-element
 * arrays) — one file's status entry within a single commit's change set. */
export type CommitFileEntry = [string, StatusKind];
