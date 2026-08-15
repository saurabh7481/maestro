import { useEffect } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  MagnifyingGlass,
  TextAa,
  TextColumns,
  X,
} from "@phosphor-icons/react";
import { useSearchStore } from "../../state/searchStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { iconForFile } from "../explorer/fileIcons";
import { ICON_SIZE } from "../../design/iconSize";
import { AlertDialog, Button, IconButton, TextInput, Tooltip } from "../primitives";
import type { FileMatches, SearchMatch } from "../../types/search";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./SearchPanel.module.css";

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { name: path, dir: "" }
    : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

function MatchRow({
  path,
  match,
  onClick,
}: {
  path: string;
  match: SearchMatch;
  onClick: () => void;
}) {
  const before = match.lineText.slice(0, match.matchStart);
  const hit = match.lineText.slice(match.matchStart, match.matchEnd);
  const after = match.lineText.slice(match.matchEnd);
  return (
    <div className={`${sidebar.row} ${sidebar.indent1} ${styles.matchRow}`} onClick={onClick}>
      <span className={styles.matchLine}>{match.line}</span>
      <span className={styles.matchText} title={`${path}:${match.line}`}>
        {before}
        <mark className={styles.matchHighlight}>{hit}</mark>
        {after}
      </span>
    </div>
  );
}

function FileGroup({
  file,
  onOpenMatch,
}: {
  file: FileMatches;
  onOpenMatch: (m: SearchMatch) => void;
}) {
  const collapsedFiles = useSearchStore((s) => s.collapsedFiles);
  const toggleFileCollapsed = useSearchStore((s) => s.toggleFileCollapsed);
  const collapsed = collapsedFiles.has(file.path);
  const { name, dir } = splitPath(file.path);
  const { icon: Icon, color } = iconForFile(name);

  return (
    <div>
      <div className={sidebar.row} onClick={() => toggleFileCollapsed(file.path)}>
        {collapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
        <span className={styles.fileIcon}>
          <Icon size={ICON_SIZE.sm} color={color} />
        </span>
        <span className={styles.fileName}>{name}</span>
        {dir && <span className={styles.filePath}>{dir}</span>}
        <span className={styles.matchCount}>{file.matches.length}</span>
      </div>
      {!collapsed &&
        file.matches.map((match, i) => (
          <MatchRow
            key={`${file.path}:${match.line}:${i}`}
            path={file.path}
            match={match}
            onClick={() => onOpenMatch(match)}
          />
        ))}
    </div>
  );
}

/** The "Search" sidebar panel — global content search + replace/replace-all
 * across the active worktree, wired into `ExplorerSidebar`'s `"search"`
 * `SidebarView` case (previously dead-ended into the plain file tree). */
export function SearchPanel() {
  const activeWorktree = useActiveWorktree();
  const query = useSearchStore((s) => s.query);
  const replacement = useSearchStore((s) => s.replacement);
  const caseSensitive = useSearchStore((s) => s.caseSensitive);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const useRegex = useSearchStore((s) => s.useRegex);
  const replaceOpen = useSearchStore((s) => s.replaceOpen);
  const results = useSearchStore((s) => s.results);
  const status = useSearchStore((s) => s.status);
  const confirmDirtyFiles = useSearchStore((s) => s.confirmDirtyFiles);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setReplacement = useSearchStore((s) => s.setReplacement);
  const setCaseSensitive = useSearchStore((s) => s.setCaseSensitive);
  const setWholeWord = useSearchStore((s) => s.setWholeWord);
  const setUseRegex = useSearchStore((s) => s.setUseRegex);
  const setReplaceOpen = useSearchStore((s) => s.setReplaceOpen);
  const runSearch = useSearchStore((s) => s.runSearch);
  const cancelSearch = useSearchStore((s) => s.cancelSearch);
  const replaceAll = useSearchStore((s) => s.replaceAll);
  const confirmReplaceAll = useSearchStore((s) => s.confirmReplaceAll);
  const dismissConfirmDirty = useSearchStore((s) => s.dismissConfirmDirty);
  const reveal = useSearchStore((s) => s.reveal);

  const worktreeRoot = activeWorktree?.path;
  const worktreeId = activeWorktree?.id;

  // Debounced-on-type search — re-runs whenever the query or an option
  // changes, ~300ms after the user stops typing, rather than firing an
  // `invoke()` per keystroke.
  useEffect(() => {
    if (!worktreeRoot) return;
    const id = window.setTimeout(() => runSearch(worktreeRoot), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, useRegex, worktreeRoot]);

  const totalMatches = results.reduce((sum, f) => sum + f.matches.length, 0);

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>Search</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-dim)",
          }}
        >
          {activeWorktree?.branch ?? "—"}
        </span>
      </div>

      <div className={styles.controls}>
        <div className={styles.inputRow}>
          <TextInput
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <Tooltip label="Match case">
            <button
              type="button"
              className={styles.toggleChip}
              data-active={caseSensitive}
              onClick={() => setCaseSensitive(!caseSensitive)}
            >
              <TextAa size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Match whole word">
            <button
              type="button"
              className={styles.toggleChip}
              data-active={wholeWord}
              onClick={() => setWholeWord(!wholeWord)}
            >
              <TextColumns size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Use regular expression">
            <button
              type="button"
              className={styles.toggleChip}
              data-active={useRegex}
              onClick={() => setUseRegex(!useRegex)}
            >
              .*
            </button>
          </Tooltip>
        </div>

        <div className={styles.replaceToggle} onClick={() => setReplaceOpen(!replaceOpen)}>
          {replaceOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
          Replace
        </div>

        {replaceOpen && (
          <div className={styles.inputRow}>
            <TextInput
              placeholder="Replace"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={results.length === 0 || !worktreeId || !worktreeRoot}
              onClick={() =>
                worktreeId && worktreeRoot && void replaceAll(worktreeId, worktreeRoot)
              }
            >
              Replace All
            </Button>
          </div>
        )}
      </div>

      <div className={sidebar.body}>
        {status === "searching" && (
          <div className={styles.statusRow}>
            <ArrowsClockwise size={13} className="mo-spin" />
            Searching…
            <IconButton
              icon={X}
              label="Cancel search"
              size="sm"
              iconSize={12}
              onClick={cancelSearch}
            />
          </div>
        )}
        {status !== "searching" && query.trim() && (
          <div className={styles.statusRow}>
            {totalMatches} {totalMatches === 1 ? "result" : "results"} in {results.length}{" "}
            {results.length === 1 ? "file" : "files"}
          </div>
        )}
        {status === "idle" && !query.trim() && (
          <div className={styles.empty}>
            <MagnifyingGlass size={26} color="var(--text-mute)" />
            <span>Search across every file in {activeWorktree?.branch ?? "this worktree"}.</span>
          </div>
        )}
        {worktreeId &&
          worktreeRoot &&
          results.map((file) => (
            <FileGroup
              key={file.path}
              file={file}
              onOpenMatch={(match) => reveal(worktreeId, worktreeRoot, file.path, match)}
            />
          ))}
      </div>

      <AlertDialog
        open={confirmDirtyFiles !== null}
        onOpenChange={(open) => !open && dismissConfirmDirty()}
        title="Replace in files with unsaved changes?"
        description={
          confirmDirtyFiles
            ? `${confirmDirtyFiles.length} matched ${confirmDirtyFiles.length === 1 ? "file has" : "files have"} unsaved changes. They'll still be modified on disk — review them after.`
            : ""
        }
        confirmLabel="Replace anyway"
        destructive
        onConfirm={() =>
          worktreeId && worktreeRoot && void confirmReplaceAll(worktreeId, worktreeRoot)
        }
      />
    </div>
  );
}
