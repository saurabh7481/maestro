export interface FsEntry {
  name: string;
  relPath: string;
  isDir: boolean;
  sizeBytes: number;
  isSymlink: boolean;
}

export type FileReadResult =
  | { kind: "text"; content: string; sizeBytes: number; mtimeMs: number }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "tooLarge"; sizeBytes: number };

export interface WriteResult {
  mtimeMs: number;
}

/** Single-character git status glyph — `D` is parsed on the Rust side for
 * completeness but never appears here in practice (a deleted path has no
 * row in an fs-backed tree to attach it to). `C` (conflicted) is distinct
 * from `M` on purpose — see `src/types/git.ts`'s `StatusKind.conflicted`. */
export type GitGlyph = "M" | "A" | "D" | "U" | "C";

export interface FsChangeEvent {
  type: "changed";
  touchedPaths: string[];
  changedDirs: string[];
  statusMap: Record<string, GitGlyph>;
}
