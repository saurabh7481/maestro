import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CaretDown, CaretRight, Folder, FolderOpen } from "@phosphor-icons/react";
import { iconForFile } from "./fileIcons";
import { ICON_SIZE } from "../../design/iconSize";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./FileTree.module.css";
import type { GitGlyph } from "../../types/fs";
import type { ProblemSummary } from "../../types/problem";

const ROW_HEIGHT = 26;
const DEPTH_STEP = 20;
const BASE_INDENT = 8;

const GLYPH_COLOR: Record<GitGlyph, string> = {
  M: "var(--yellow)",
  A: "var(--green)",
  D: "var(--red)",
  U: "var(--green)",
  C: "var(--red)",
};

export interface TreeRow {
  relPath: string;
  name: string;
  depth: number;
  isDir: boolean;
  isExpanded: boolean;
  glyph?: GitGlyph;
  problemSummary?: ProblemSummary;
}

interface FileTreeRowProps {
  row: TreeRow;
  active: boolean;
  isRenaming: boolean;
  virtualStart: number;
  /** Current zoom multiplier — row height and indent are inline pixel
   * styles (the virtualizer needs real numbers, not CSS `rem`), so unlike
   * the rest of this row's sizing (which rides `--zoom`-scaled rem tokens
   * automatically) they have to be scaled by hand to keep the row's actual
   * rendered height in sync with what `FileTree.tsx` told the virtualizer
   * to reserve — otherwise rows overlap at any zoom other than 100%. */
  zoom: number;
  onToggle: () => void;
  onOpen: () => void;
  onStartRename: () => void;
  onCommitRename: (newName: string) => void;
  onCancelRename: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onDelete: () => void;
  onRevealInOs: () => void;
}

export function FileTreeRow({
  row,
  active,
  isRenaming,
  virtualStart,
  zoom,
  onToggle,
  onOpen,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNewFile,
  onNewFolder,
  onDelete,
  onRevealInOs,
}: FileTreeRowProps) {
  const { icon: FileIcon, color: fileColor } = iconForFile(row.name);
  const [draftName, setDraftName] = useState(row.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focuses the rename input once it mounts — a DOM-focused effect, not a
  // state sync, so it doesn't call setState (see beginRename() below for
  // where draftName actually gets reset).
  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [isRenaming]);

  function beginRename() {
    setDraftName(row.name);
    onStartRename();
  }

  const style: CSSProperties = {
    transform: `translateY(${virtualStart}px)`,
    height: ROW_HEIGHT * zoom,
    paddingLeft: (BASE_INDENT + row.depth * DEPTH_STEP) * zoom,
  };

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const trimmed = draftName.trim();
      if (trimmed && trimmed !== row.name) onCommitRename(trimmed);
      else onCancelRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancelRename();
    }
  }

  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      (row.isDir ? onToggle : onOpen)();
    } else if (event.key === "ArrowRight" && row.isDir && !row.isExpanded) {
      event.preventDefault();
      onToggle();
    } else if (event.key === "ArrowLeft" && row.isDir && row.isExpanded) {
      event.preventDefault();
      onToggle();
    } else if (event.key === "F2") {
      event.preventDefault();
      beginRename();
    }
  }

  const content = (
    <div
      className={styles.rowWrap}
      style={style}
      role="treeitem"
      aria-expanded={row.isDir ? row.isExpanded : undefined}
      aria-selected={active}
      tabIndex={isRenaming ? -1 : 0}
      onKeyDown={handleTreeKeyDown}
    >
      <div
        className={`${sidebar.row} ${styles.row}`}
        data-active={active}
        draggable={!row.isDir && !isRenaming}
        onDragStart={
          row.isDir
            ? undefined
            : (e) => {
                // Custom type first so the composer's drop handler can
                // tell "a file from our own tree" apart from any other
                // drag source without guessing from content — `text/plain`
                // stays a fallback for anything reading the drag generically.
                e.dataTransfer.setData("application/x-maestro-file-path", row.relPath);
                e.dataTransfer.setData("text/plain", row.relPath);
                e.dataTransfer.effectAllowed = "copy";
              }
        }
        onClick={row.isDir ? onToggle : onOpen}
        onDoubleClick={beginRename}
      >
        {row.isDir ? (
          <span className={styles.caret}>
            {row.isExpanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
          </span>
        ) : (
          <span className={styles.caret} />
        )}
        <span className={styles.icon}>
          {row.isDir ? (
            row.isExpanded ? (
              <FolderOpen size={ICON_SIZE.sm} color="var(--accent-2)" />
            ) : (
              <Folder size={ICON_SIZE.sm} color="var(--text-mute)" />
            )
          ) : (
            <FileIcon size={ICON_SIZE.sm} color={fileColor} />
          )}
        </span>
        {isRenaming ? (
          <input
            ref={inputRef}
            className={styles.renameInput}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => onCancelRename()}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={sidebar.rowLabel}>{row.name}</span>
        )}
        {!isRenaming && row.glyph && (
          <span className={styles.statusGlyph} style={{ color: GLYPH_COLOR[row.glyph] }}>
            {row.glyph}
          </span>
        )}
        {!isRenaming && row.problemSummary && row.problemSummary.total > 0 && (
          <span
            className={styles.problemBadge}
            data-severity={row.problemSummary.highestSeverity}
            title={`${row.problemSummary.total} problem${row.problemSummary.total === 1 ? "" : "s"}`}
          >
            {row.problemSummary.total}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <ExplorerContextMenu
      isDir={row.isDir}
      onNewFile={onNewFile}
      onNewFolder={onNewFolder}
      onRename={beginRename}
      onDelete={onDelete}
      onRevealInOs={onRevealInOs}
    >
      {content}
    </ExplorerContextMenu>
  );
}

export { ROW_HEIGHT };
