import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FilePlus, FolderSimplePlus } from "@phosphor-icons/react";
import { useExplorerStore } from "../../state/explorerStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore, fileTabId } from "../../state/tabsStore";
import { IconButton, AlertDialog } from "../primitives";
import { FileTreeRow, ROW_HEIGHT } from "./FileTreeRow";
import type { TreeRow } from "./FileTreeRow";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./FileTree.module.css";
import type { FsEntry, GitGlyph } from "../../types/fs";
import { buildProblemPathSummaries, useProblemsStore } from "../../state/problemsStore";
import type { ProblemSummary } from "../../types/problem";

const PENDING_PATH = "__pending__";

interface PendingCreate {
  parentRel: string;
  isDir: boolean;
}

function flatten(
  childrenByDir: Map<string, FsEntry[]>,
  expandedPaths: Set<string>,
  statusMap: Record<string, GitGlyph>,
  pendingCreate: PendingCreate | null,
  problemSummaries: Record<string, ProblemSummary>,
): TreeRow[] {
  const rows: TreeRow[] = [];

  function walk(dirPath: string, depth: number) {
    const entries = childrenByDir.get(dirPath) ?? [];
    for (const entry of entries) {
      const isExpanded = entry.isDir && expandedPaths.has(entry.relPath);
      rows.push({
        relPath: entry.relPath,
        name: entry.name,
        depth,
        isDir: entry.isDir,
        isExpanded,
        glyph: statusMap[entry.relPath],
        problemSummary: problemSummaries[entry.relPath],
      });
      if (isExpanded) walk(entry.relPath, depth + 1);
    }
    if (pendingCreate && pendingCreate.parentRel === dirPath) {
      rows.push({
        relPath: PENDING_PATH,
        name: "",
        depth,
        isDir: pendingCreate.isDir,
        isExpanded: false,
      });
    }
  }

  walk("", 0);
  return rows;
}

function isMarkdown(name: string): boolean {
  return /\.mdx?$/i.test(name);
}

export function FileTree() {
  const activeWorktree = useActiveWorktree();
  const childrenByDir = useExplorerStore((s) => s.childrenByDir);
  const expandedPaths = useExplorerStore((s) => s.expandedPaths);
  const statusMap = useExplorerStore((s) => s.statusMap);
  const worktreeId = useExplorerStore((s) => s.worktreeId);
  const worktreeRoot = useExplorerStore((s) => s.worktreeRoot);
  const toggleDir = useExplorerStore((s) => s.toggleDir);
  const createEntry = useExplorerStore((s) => s.createEntry);
  const renameEntry = useExplorerStore((s) => s.renameEntry);
  const deleteEntry = useExplorerStore((s) => s.deleteEntry);
  const problemsByOwner = useProblemsStore((state) => state.byOwner);

  const ensureTab = useTabsStore((s) => s.ensureTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TreeRow | null>(null);

  const problemSummaries = useMemo(
    () => buildProblemPathSummaries(problemsByOwner, worktreeId),
    [problemsByOwner, worktreeId],
  );
  const rows = useMemo(
    () => flatten(childrenByDir, expandedPaths, statusMap, pendingCreate, problemSummaries),
    [childrenByDir, expandedPaths, statusMap, pendingCreate, problemSummaries],
  );

  const zoom = useUiStore((s) => s.zoom);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT * zoom,
    overscan: 12,
  });

  // `estimateSize` above only feeds the virtualizer's *initial* estimate —
  // it doesn't retroactively resize rows it already measured, so without
  // this a zoom change leaves stale (pre-zoom) offsets in place and rows
  // start overlapping/gapping. `measure()` forces every row's offset to be
  // recomputed from the current `estimateSize`.
  useEffect(() => {
    virtualizer.measure();
    // The virtualizer object is not referentially stable: including it in
    // this dependency list creates a render -> measure -> render loop in
    // WebKit. Re-measurement is needed only when our row estimate changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  function openFile(row: TreeRow) {
    if (!worktreeId || !worktreeRoot) return;
    ensureTab({
      id: fileTabId(worktreeId, row.relPath),
      type: isMarkdown(row.name) ? "markdown" : "file",
      title: row.name,
      filePath: row.relPath,
      worktreeRoot,
      worktreeId,
    });
  }

  function commitPendingCreate(name: string) {
    if (!pendingCreate) return;
    void createEntry(pendingCreate.parentRel, name, pendingCreate.isDir);
    setPendingCreate(null);
  }

  function commitRename(row: TreeRow, name: string) {
    const parent = row.relPath.includes("/")
      ? row.relPath.slice(0, row.relPath.lastIndexOf("/"))
      : "";
    const toRel = parent ? `${parent}/${name}` : name;
    void renameEntry(row.relPath, toRel);
    setRenamingPath(null);
  }

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>
          Explorer · {activeWorktree?.branch ?? "no worktree selected"}
        </span>
        <div className={sidebar.headerActions}>
          <IconButton
            icon={FilePlus}
            label="New file"
            size="sm"
            iconSize={14}
            disabled={!worktreeId}
            onClick={() => setPendingCreate({ parentRel: "", isDir: false })}
          />
          <IconButton
            icon={FolderSimplePlus}
            label="New folder"
            size="sm"
            iconSize={14}
            disabled={!worktreeId}
            onClick={() => setPendingCreate({ parentRel: "", isDir: true })}
          />
        </div>
      </div>

      {!worktreeId ? (
        <div className={styles.empty}>No worktree selected.</div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>Empty worktree.</div>
      ) : (
        <div ref={scrollRef} className={styles.scroller}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} role="tree">
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row.relPath === PENDING_PATH) {
                return (
                  <FileTreeRow
                    key="pending-create"
                    row={row}
                    active={false}
                    isRenaming
                    virtualStart={item.start}
                    zoom={zoom}
                    onToggle={() => {}}
                    onOpen={() => {}}
                    onStartRename={() => {}}
                    onCommitRename={commitPendingCreate}
                    onCancelRename={() => setPendingCreate(null)}
                    onNewFile={() => {}}
                    onNewFolder={() => {}}
                    onDelete={() => {}}
                  />
                );
              }
              return (
                <FileTreeRow
                  key={row.relPath}
                  row={row}
                  active={
                    !row.isDir &&
                    activeTabId === (worktreeId ? fileTabId(worktreeId, row.relPath) : "")
                  }
                  isRenaming={renamingPath === row.relPath}
                  virtualStart={item.start}
                  zoom={zoom}
                  onToggle={() => toggleDir(row.relPath)}
                  onOpen={() => openFile(row)}
                  onStartRename={() => setRenamingPath(row.relPath)}
                  onCommitRename={(name) => commitRename(row, name)}
                  onCancelRename={() => setRenamingPath(null)}
                  onNewFile={() => setPendingCreate({ parentRel: row.relPath, isDir: false })}
                  onNewFolder={() => setPendingCreate({ parentRel: row.relPath, isDir: true })}
                  onDelete={() => setDeleteTarget(row)}
                />
              );
            })}
          </div>
        </div>
      )}

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? ""}?`}
        description={
          deleteTarget?.isDir
            ? "This deletes the folder and everything inside it. This can't be undone."
            : "This can't be undone."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteTarget) void deleteEntry(deleteTarget.relPath);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
