import { Fragment } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import { CaretRight } from "@phosphor-icons/react";
import { useExplorerStore } from "../../state/explorerStore";
import { useUiStore } from "../../state/uiStore";
import { iconForFile } from "../explorer/fileIcons";
import { ICON_SIZE } from "../../design/iconSize";
import styles from "./EditorBreadcrumb.module.css";

function revealInSidebar(relPath: string) {
  useUiStore.getState().setSidebarView("explorer");
  void useExplorerStore.getState().revealPath(relPath);
}

/** Walks down `symbols` to the innermost one containing `position` — the
 * outline-hierarchy equivalent of VS Code's breadcrumb symbol trail.
 * Siblings are assumed non-overlapping (true of every real language
 * server's output), so the first containing match at each level is the
 * right one to descend into. */
function symbolPathAt(
  symbols: monaco.languages.DocumentSymbol[],
  position: monaco.Position,
): monaco.languages.DocumentSymbol[] {
  for (const symbol of symbols) {
    if (monaco.Range.containsPosition(symbol.range, position)) {
      return [symbol, ...symbolPathAt(symbol.children ?? [], position)];
    }
  }
  return [];
}

export interface EditorBreadcrumbProps {
  filePath: string;
  symbols: monaco.languages.DocumentSymbol[];
  position: monaco.Position | null;
  onRevealSymbol: (symbol: monaco.languages.DocumentSymbol) => void;
}

/** A VS Code-style breadcrumb above the editor: the file's folder path
 * (click a segment to reveal it in the sidebar tree) followed by the
 * symbol path the cursor currently sits inside (click one to jump the
 * editor there) — built from `lsp/providers.ts`'s own document-symbol
 * data, so it's only ever as good as whatever LSP session is running. */
export function EditorBreadcrumb({
  filePath,
  symbols,
  position,
  onRevealSymbol,
}: EditorBreadcrumbProps) {
  const segments = filePath.split("/");
  const fileName = segments[segments.length - 1];
  const folders = segments.slice(0, -1);
  const { icon: FileIcon, color: fileColor } = iconForFile(fileName);
  const symbolPath = position ? symbolPathAt(symbols, position) : [];

  return (
    <div className={styles.bar}>
      {folders.map((folder, index) => {
        const relPath = segments.slice(0, index + 1).join("/");
        return (
          <Fragment key={relPath}>
            <button
              type="button"
              className={styles.segment}
              onClick={() => revealInSidebar(relPath)}
            >
              {folder}
            </button>
            <CaretRight size={10} className={styles.separator} />
          </Fragment>
        );
      })}
      <button type="button" className={styles.segment} onClick={() => revealInSidebar(filePath)}>
        <FileIcon size={ICON_SIZE.xs} color={fileColor} />
        {fileName}
      </button>
      {symbolPath.map((symbol) => (
        <Fragment key={`${symbol.name}:${symbol.range.startLineNumber}`}>
          <CaretRight size={10} className={styles.separator} />
          <button type="button" className={styles.segment} onClick={() => onRevealSymbol(symbol)}>
            {symbol.name}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
