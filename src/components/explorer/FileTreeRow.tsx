import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CaretDown, CaretRight, Folder, FolderOpen } from "@phosphor-icons/react";
import { iconForFile } from "./fileIcons";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./FileTree.module.css";
import type { GitGlyph } from "../../types/fs";

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
}

interface FileTreeRowProps {
  row: TreeRow;
  active: boolean;
  isRenaming: boolean;
  virtualStart: number;
  onToggle: () => void;
  onOpen: () => void;
  onStartRename: () => void;
  onCommitRename: (newName: string) => void;
  onCancelRename: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onDelete: () => void;
}

export function FileTreeRow({
  row,
  active,
  isRenaming,
  virtualStart,
  onToggle,
  onOpen,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNewFile,
  onNewFolder,
  onDelete,
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
    height: ROW_HEIGHT,
    paddingLeft: BASE_INDENT + row.depth * DEPTH_STEP,
  };

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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

  const content = (
    <div
      className={styles.rowWrap}
      style={style}
      role="treeitem"
      aria-expanded={row.isDir ? row.isExpanded : undefined}
    >
      <div
        className={sidebar.row}
        data-active={active}
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
              <FolderOpen size={15} color="var(--accent-2)" />
            ) : (
              <Folder size={15} color="var(--text-mute)" />
            )
          ) : (
            <FileIcon size={15} color={fileColor} />
          )}
        </span>
        {isRenaming ? (
          <input
            ref={inputRef}
            className={styles.renameInput}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={handleKeyDown}
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
    >
      {content}
    </ExplorerContextMenu>
  );
}

export { ROW_HEIGHT };
