import { afterEach, describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { convertWorkspaceEdit } from "./clientManager";
import { worktreeForFile } from "./editorOpener";
import type { Worktree } from "../types/workspace";

afterEach(() => {
  for (const model of monaco.editor.getModels()) model.dispose();
});

const edit = (start: number, end: number, newText = "x") => ({
  range: {
    start: { line: 0, character: start },
    end: { line: 0, character: end },
  },
  newText,
});

describe("safe LSP workspace edits", () => {
  it("converts loaded in-worktree edits with a model version guard", () => {
    const uri = monaco.Uri.file("/repo/src/a.ts");
    const model = monaco.editor.createModel("hello", "plaintext", uri);
    const result = convertWorkspaceEdit("/repo", {
      changes: { [uri.toString()]: [edit(0, 5, "world")] },
    });
    expect(result.rejection).toBeUndefined();
    const converted = result.edit?.edits[0] as monaco.languages.IWorkspaceTextEdit;
    expect(converted.versionId).toBe(model.getVersionId());
    expect(converted.textEdit.text).toBe("world");
  });

  it("rejects traversal-by-prefix, unloaded files, and overlapping edits", () => {
    const outside = monaco.Uri.file("/repo-other/a.ts");
    expect(
      convertWorkspaceEdit("/repo", { changes: { [outside.toString()]: [edit(0, 0)] } }).rejection,
    ).toContain("outside");

    const unopened = monaco.Uri.file("/repo/unopened.ts");
    expect(
      convertWorkspaceEdit("/repo", { changes: { [unopened.toString()]: [edit(0, 0)] } }).rejection,
    ).toContain("unopened");

    const loaded = monaco.Uri.file("/repo/a.ts");
    monaco.editor.createModel("hello", "plaintext", loaded);
    expect(
      convertWorkspaceEdit("/repo", {
        changes: { [loaded.toString()]: [edit(0, 3), edit(2, 4)] },
      }).rejection,
    ).toContain("overlapping");
  });
});

describe("definition target worktree resolution", () => {
  it("uses path boundaries and selects the most specific nested root", () => {
    const base = (id: string, path: string): Worktree => ({
      id,
      projectId: "p",
      path,
      branch: "main",
      isPrimary: true,
      isDetached: false,
      isLocked: false,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: 0,
    });
    const match = worktreeForFile("/repo/packages/app/src/a.ts", [
      base("root", "/repo"),
      base("nested", "/repo/packages/app"),
      base("sibling", "/repo-other"),
    ]);
    expect(match?.worktree.id).toBe("nested");
    expect(worktreeForFile("/repo-otherness/a.ts", [base("root", "/repo")])).toBeUndefined();
  });
});
