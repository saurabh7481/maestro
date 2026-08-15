import { useEffect, useState } from "react";
import { ArrowCounterClockwise, Folder, GitDiff, Minus, Plus } from "@phosphor-icons/react";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { useScmStore } from "../../state/scmStore";
import { formatBytes } from "../../editor/formatBytes";
import { AlertDialog } from "../primitives";
import { MonacoDiffHost } from "./MonacoDiffHost";
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
            <span className={styles.added}>+{diff.added}</span>
            <span className={styles.removed}>−{diff.removed}</span>
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
              This is a directory, not a file — most likely a nested Git worktree or submodule
              that git won't expand into individual files.
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
          <MonacoDiffHost relPath={relPath} oldText={diff.oldText} newText={diff.newText} />
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
