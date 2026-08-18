import { useEffect, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  Columns,
  Folder,
  GitDiff,
  Minus,
  Plus,
  Rows,
} from "@phosphor-icons/react";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { useScmStore } from "../../state/scmStore";
import { useUiStore } from "../../state/uiStore";
import { formatBytes } from "../../editor/formatBytes";
import { AlertDialog, IconButton, Tooltip } from "../primitives";
import { MonacoDiffHost, type DiffNavState, type MonacoDiffHostHandle } from "./MonacoDiffHost";
import type { DiffContent } from "../../types/git";
import styles from "./DiffView.module.css";

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { name: path, dir: "" }
    : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

/** Tab content for `type: "diff"` — header chrome ported from
 * `docs/design/Maestro IDE.dc.html`'s `<!-- DIFF -->` block, backed by a
 * real `MonacoDiffHost` instead of that mock's hand-rolled two-pane markup
 * (per `docs/ARCHITECTURE.md` §7). Fetches its own diff content (cached in
 * `scmStore`) independently of `MonacoDiffHost`, which only needs the text
 * — this component additionally needs the `+N/−N` stat and binary sizes
 * for the header/summary panel. */
export function DiffView({ tab }: { tab: Tab }) {
  const getDiff = useScmStore((s) => s.getDiff);
  const stagePaths = useScmStore((s) => s.stagePaths);
  const unstagePaths = useScmStore((s) => s.unstagePaths);
  const discardChange = useScmStore((s) => s.discardChange);
  const closeTab = useTabsStore((s) => s.closeTab);

  const relPath = tab.filePath ?? "";
  const mode = tab.diffMode ?? "unstaged";

  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [navState, setNavState] = useState<DiffNavState | null>(null);
  const [hunkBusy, setHunkBusy] = useState(false);
  const diffHostRef = useRef<MonacoDiffHostHandle>(null);
  const diffSideBySide = useUiStore((s) => s.diffSideBySide);
  const setDiffSideBySide = useUiStore((s) => s.setDiffSideBySide);

  // `key={activeTab.id}` at MainContent's call site remounts this
  // component per tab, so `diff`/`error` already start `null` for each new
  // tab — no synchronous reset needed here, just the fetch itself.
  useEffect(() => {
    let cancelled = false;
    getDiff(relPath, mode, tab.commitHash)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [getDiff, relPath, mode, tab.commitHash]);

  const { name, dir } = splitPath(relPath);

  async function stageCurrentHunk() {
    setHunkBusy(true);
    try {
      await diffHostRef.current?.stageCurrentHunk();
    } catch (err) {
      setError(String(err));
    } finally {
      setHunkBusy(false);
    }
  }

  // The diff this tab shows no longer applies once the underlying file has
  // been staged/unstaged/discarded from within it — simplest correct
  // behavior is to close the tab; the (now up to date) SCM sidebar is
  // where the user picks up from, rather than guessing which tab to open
  // next under a possible event-ordering race.
  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    try {
      await action();
      closeTab(tab.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <GitDiff size={15} color="var(--orange)" />
        <span className={styles.filename}>{name}</span>
        {dir && <span className={styles.dir}>{dir}</span>}
        {diff?.kind === "text" && (
          <>
            {/* Live from Monaco's own diff computation once it's mounted
                (reflects in-progress edits/hunk-reverts immediately);
                falls back to the git-computed stat from `getDiff` before
                that first report lands. */}
            <span className={styles.added}>+{navState?.added ?? diff.added}</span>
            <span className={styles.removed}>−{navState?.removed ?? diff.removed}</span>
            <div className={styles.diffNav}>
              <Tooltip label="Previous change">
                <IconButton
                  icon={CaretUp}
                  label="Previous change"
                  size="sm"
                  iconSize={13}
                  disabled={!navState || navState.count === 0}
                  onClick={() => diffHostRef.current?.goToPreviousChange()}
                />
              </Tooltip>
              <Tooltip label="Next change">
                <IconButton
                  icon={CaretDown}
                  label="Next change"
                  size="sm"
                  iconSize={13}
                  disabled={!navState || navState.count === 0}
                  onClick={() => diffHostRef.current?.goToNextChange()}
                />
              </Tooltip>
              {navState && navState.count > 0 && (
                <span className={styles.changeCount}>
                  {navState.count} {navState.count === 1 ? "change" : "changes"}
                </span>
              )}
              <Tooltip
                label={diffSideBySide ? "Switch to inline view" : "Switch to side-by-side view"}
              >
                <IconButton
                  icon={diffSideBySide ? Columns : Rows}
                  label={diffSideBySide ? "Switch to inline view" : "Switch to side-by-side view"}
                  size="sm"
                  iconSize={13}
                  onClick={() => setDiffSideBySide(!diffSideBySide)}
                />
              </Tooltip>
              {mode !== "commit" && (
                <Tooltip label={mode === "staged" ? "Unstage this hunk" : "Stage this hunk"}>
                  <IconButton
                    icon={mode === "staged" ? Minus : Plus}
                    label={mode === "staged" ? "Unstage this hunk" : "Stage this hunk"}
                    size="sm"
                    iconSize={13}
                    disabled={!navState || navState.count === 0 || hunkBusy}
                    onClick={() => void stageCurrentHunk()}
                  />
                </Tooltip>
              )}
            </div>
          </>
        )}
        <div className={styles.actions}>
          {mode === "commit" && <span className={styles.readOnlyBadge}>Read-only</span>}
          {/* A directory entry (nested worktree/submodule boundary — see the
              body panel below) isn't something a plain Stage/Revert click
              should touch: staging it would add it to the index as a
              gitlink, and there's nothing to line-diff. */}
          {diff?.kind !== "directory" && mode === "unstaged" && (
            <>
              <button
                type="button"
                className={styles.actionBtn}
                data-variant="primary"
                disabled={busy !== null}
                onClick={() => void run("stage", () => stagePaths([relPath]))}
              >
                <Plus size={13} />
                Stage
              </button>
              <button
                type="button"
                className={styles.actionBtn}
                disabled={busy !== null}
                onClick={() => setConfirmRevert(true)}
              >
                <ArrowCounterClockwise size={13} />
                Revert
              </button>
            </>
          )}
          {diff?.kind !== "directory" && mode === "staged" && (
            <button
              type="button"
              className={styles.actionBtn}
              disabled={busy !== null}
              onClick={() => void run("unstage", () => unstagePaths([relPath]))}
            >
              <Minus size={13} />
              Unstage
            </button>
          )}
        </div>
      </div>

      <div className={styles.body}>
        {error && <div className={styles.errorPanel}>{error}</div>}
        {!error && !diff && <div className={styles.centered}>Loading diff…</div>}
        {!error && diff?.kind === "directory" && (
          <div className={styles.binaryPanel}>
            <Folder size={28} color="var(--text-mute)" />
            <span>
              This is a directory, not a file — most likely a nested Git worktree or submodule that
              git won't expand into individual files.
            </span>
          </div>
        )}
        {!error && diff?.kind === "binary" && (
          <div className={styles.binaryPanel}>
            <span>Binary file changed</span>
            <span className={styles.binarySizes}>
              <span>{diff.oldSize == null ? "—" : formatBytes(diff.oldSize)}</span>
              <span>→</span>
              <span>{diff.newSize == null ? "—" : formatBytes(diff.newSize)}</span>
            </span>
          </div>
        )}
        {!error && diff?.kind === "text" && (
          <MonacoDiffHost
            ref={diffHostRef}
            relPath={relPath}
            oldText={diff.oldText}
            newText={diff.newText}
            worktreeRoot={tab.worktreeRoot ?? ""}
            mode={mode}
            onNavStateChange={setNavState}
          />
        )}
      </div>

      <AlertDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        title="Discard changes?"
        description={`This permanently discards unstaged changes to "${name}". This can't be undone.`}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmRevert(false);
          void run("discard", () => discardChange(relPath));
        }}
      />
    </div>
  );
}
