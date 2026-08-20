import * as monaco from "monaco-editor/editor/editor.api";
import { useWorkspaceStore } from "../state/workspaceStore";
import { classifyFileTabType, fileTabId, useTabsStore } from "../state/tabsStore";
import { useEditorNavigationStore } from "../state/editorNavigationStore";
import type { Worktree } from "../types/workspace";

function normalized(path: string) {
  const value = path.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[A-Z]:/.test(value) ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value;
}

export function worktreeForFile(path: string, worktrees: Worktree[]) {
  const target = normalized(path);
  return worktrees
    .map((worktree) => ({ worktree, root: normalized(worktree.path) }))
    .filter(({ root }) => target !== root && target.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

export function registerMaestroEditorOpener(): monaco.IDisposable {
  return monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      const target = normalized(resource.fsPath);
      const workspace = useWorkspaceStore.getState();
      const worktrees = Object.values(workspace.worktreesByProject).flat();
      const match = worktreeForFile(target, worktrees);
      if (!match) return false;
      const relativePath = target.slice(match.root.length + 1);
      const id = fileTabId(match.worktree.id, relativePath);
      workspace.selectWorktree(match.worktree.projectId, match.worktree.id);
      useTabsStore.getState().ensureTab({
        id,
        type: classifyFileTabType(relativePath),
        title: relativePath.split("/").pop() ?? relativePath,
        filePath: relativePath,
        worktreeId: match.worktree.id,
        worktreeRoot: match.worktree.path,
      });
      useEditorNavigationStore.getState().request({
        tabId: id,
        selection: selectionOrPosition,
      });
      return true;
    },
  });
}
