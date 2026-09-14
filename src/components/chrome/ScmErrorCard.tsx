import { useEffect, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  Lock,
  Prohibit,
  WarningCircle,
  WarningOctagon,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useScmStore } from "../../state/scmStore";
import { IconButton } from "../primitives";
import type { GitErrorAction, GitErrorCode, GitRemoteError } from "../../types/git";
import styles from "./ScmErrorCard.module.css";

/** Never show more than this many blocking paths inline — a merge that
 * would clobber 200 files is a scrollbar, not information. The rest are
 * still in the raw details. */
const MAX_PATHS = 6;

const ICON_FOR_CODE: Partial<Record<GitErrorCode, Icon>> = {
  network: WifiSlash,
  timedOut: WifiSlash,
  authFailed: Lock,
  hostKey: Lock,
  repositoryNotFound: Prohibit,
  noRemote: Prohibit,
  rejected: WarningOctagon,
  hookRejected: WarningOctagon,
  forcePushStale: WarningOctagon,
  locked: Lock,
};

const ACTION_LABEL: Record<GitErrorAction, string> = {
  stashAndPull: "Stash & Pull",
  rebasePull: "Pull (rebase)",
  mergePull: "Pull (merge)",
  pullThenPush: "Pull, then Push",
  forcePush: "Force Push",
  retry: "Try Again",
};

/** Actions that rewrite or discard nothing are one click. `forcePush`
 * replaces whatever is on the remote, so it asks once — the same
 * two-step every git client puts in front of a force push. */
const CONFIRM_ACTIONS: Partial<Record<GitErrorAction, string>> = {
  forcePush: "Overwrite the remote?",
};

/** The Source Control panel's failure surface. Mounted under a key
 * derived from the error (see `CommitBox`), so a *different* failure
 * arrives as a fresh card rather than inheriting the previous one's
 * expanded details or half-answered force-push confirmation.
 *
 * Replaces what used to be a single `<div>` holding `String(error)`: git's
 * raw multi-line stderr, rendered with collapsed whitespace so every
 * blocking path ran together into one unreadable red paragraph, with
 * nothing to click and no hint about what to do next. Here the same
 * failure arrives pre-classified from `git_remote.rs`, so this can lead
 * with a headline and a sentence of plain English, list the paths git
 * actually named, offer the remedies that apply as buttons — and keep
 * git's verbatim output one disclosure away for when it matters. */
export function ScmErrorCard({ error }: { error: GitRemoteError }) {
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<GitErrorAction | null>(null);
  /** Which remedy the user clicked, so the spinner lands on that one
   * button instead of all of them. */
  const [running, setRunning] = useState<GitErrorAction | null>(null);
  const clearError = useScmStore((s) => s.clearError);
  const busy = useScmStore((s) => s.busy);
  const pull = useScmStore((s) => s.pull);
  const push = useScmStore((s) => s.push);
  const pullThenPush = useScmStore((s) => s.pullThenPush);
  const retryLastRemote = useScmStore((s) => s.retryLastRemote);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const Glyph = ICON_FOR_CODE[error.code] ?? WarningCircle;
  const hiddenPaths = Math.max(0, error.paths.length - MAX_PATHS);

  function runAction(action: GitErrorAction) {
    if (CONFIRM_ACTIONS[action] && confirming !== action) {
      setConfirming(action);
      return;
    }
    setConfirming(null);
    setRunning(action);
    // Every remedy reports its own outcome through the store (a new error
    // card, or a success toast); a rejection here needs no extra handling.
    const done = () => setRunning(null);
    switch (action) {
      case "stashAndPull":
        void pull("stashFastForward")
          .catch(() => {})
          .finally(done);
        break;
      case "rebasePull":
        void pull("rebase")
          .catch(() => {})
          .finally(done);
        break;
      case "mergePull":
        void pull("merge")
          .catch(() => {})
          .finally(done);
        break;
      case "pullThenPush":
        void pullThenPush().finally(done);
        break;
      case "forcePush":
        void push(true)
          .catch(() => {})
          .finally(done);
        break;
      case "retry":
        void retryLastRemote().finally(done);
        break;
    }
  }

  async function copyDetail() {
    try {
      await navigator.clipboard.writeText(error.detail);
      setCopied(true);
    } catch {
      // Clipboard denied — the text is on screen and selectable anyway.
    }
  }

  return (
    <div className={styles.card} role="alert">
      <div className={styles.head}>
        <Glyph size={14} weight="fill" className={styles.glyph} />
        <span className={styles.title}>{error.title}</span>
        <IconButton
          icon={X}
          label="Dismiss"
          size="sm"
          iconSize={12}
          className={styles.dismiss}
          onClick={clearError}
        />
      </div>

      <p className={styles.message}>{error.message}</p>

      {error.paths.length > 0 && (
        <ul className={styles.paths}>
          {error.paths.slice(0, MAX_PATHS).map((path) => (
            <li key={path} className={styles.path} title={path}>
              {path}
            </li>
          ))}
          {hiddenPaths > 0 && (
            <li className={styles.pathMore}>
              and {hiddenPaths} more {hiddenPaths === 1 ? "file" : "files"}
            </li>
          )}
        </ul>
      )}

      {error.actions.length > 0 && (
        <div className={styles.actions}>
          {error.actions.map((action) => (
            <button
              key={action}
              type="button"
              className={styles.action}
              data-confirming={confirming === action || undefined}
              disabled={busy !== null}
              onClick={() => runAction(action)}
            >
              {running === action && <ArrowsClockwise size={12} className="mo-spin" />}
              {confirming === action ? CONFIRM_ACTIONS[action] : ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      )}

      <div className={styles.detailRow}>
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={showDetail}
          onClick={() => setShowDetail((open) => !open)}
        >
          {showDetail ? <CaretDown size={10} /> : <CaretRight size={10} />}
          {showDetail ? "Hide details" : "Show details"}
        </button>
        {showDetail && (
          <button type="button" className={styles.disclosure} onClick={() => void copyDetail()}>
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {showDetail && <pre className={styles.detail}>{error.detail}</pre>}
    </div>
  );
}
