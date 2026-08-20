import { useEffect, useState } from "react";
import { ArrowCounterClockwise, WarningCircle } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useScmStore } from "../../state/scmStore";
import { computeTurnFileChanges } from "../../state/agentFileChanges";
import type { ReviewFile } from "../../types/git";
import type { AgentKind } from "../../types/agent";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import { relativeTime } from "../../design/relativeTime";
import { AgentBrandIcon } from "./AgentBrandIcon";
import type { TurnCompleteItem } from "./processingBlocks";
import { glyphFor, splitPath } from "../chrome/scmRows";
import { IconButton, AlertDialog, Tooltip } from "../primitives";
import sidebar from "../chrome/Sidebar.module.css";
import styles from "./AgentChangesPanel.module.css";

/** A turn's own `id`s are drawn from `agentSessionStore.ts`'s single
 * module-level `itemSeq` counter, shared across *every* run — so, unlike
 * `completedAtMs` (missing on turns from before that field existed, and
 * in any case a wall-clock time two turns from different runs could tie
 * on), the numeric suffix is a reliable *relative* order across every tab
 * in this worktree at once. Used only for "which of these turns came
 * later," not for display. */
function turnSeq(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Slices one run's transcript into its completed turns — each a
 * contiguous run of items ending in that turn's `turnComplete` marker.
 * Whatever's left after the last one (a turn still in progress, or none
 * yet) has no `turnComplete` to key or size a change-set from, so it's
 * dropped: this panel only ever shows *finished* turns. */
function completedTurns(
  items: TranscriptItem[],
): { turnItems: TranscriptItem[]; complete: TurnCompleteItem }[] {
  const turns: { turnItems: TranscriptItem[]; complete: TurnCompleteItem }[] = [];
  let buffer: TranscriptItem[] = [];
  for (const item of items) {
    buffer.push(item);
    if (item.kind === "turnComplete") {
      turns.push({ turnItems: buffer, complete: item });
      buffer = [];
    }
  }
  return turns;
}

interface TurnEntry {
  key: string;
  runId: string;
  tabTitle: string;
  agentKind: AgentKind;
  seq: number;
  completedAtMs: number | null;
  files: ReviewFile[];
}

/** One turn's discard button, and the confirmation for it. Discarding
 * reverts every file the turn touched back to the last commit — the same
 * `git restore`/untracked-delete `useScmStore` already does for the SCM
 * panel's own discard buttons (`ExplorerSidebar.tsx`), just handed a
 * turn-scoped path list instead of the whole working tree's. Git has no
 * concept of "just this turn's edit" independent of the file's current
 * content, so a file another, *later* still-uncommitted turn also
 * touched is named explicitly in the confirmation — discarding here
 * reverts it too, which is worth knowing before confirming, not after. */
function DiscardTurnButton({ entry, overlapping }: { entry: TurnEntry; overlapping: Set<string> }) {
  const [open, setOpen] = useState(false);
  const overlapCount = entry.files.filter((file) => overlapping.has(file.path)).length;

  return (
    <>
      <Tooltip label="Discard this turn's changes" side="left">
        <IconButton
          icon={ArrowCounterClockwise}
          label="Discard this turn's changes"
          size="sm"
          iconSize={13}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <AlertDialog
        open={open}
        onOpenChange={setOpen}
        title="Discard this turn's changes?"
        description={
          <div className={styles.confirmList}>
            <p>
              This will revert {entry.files.length} {entry.files.length === 1 ? "file" : "files"} to
              the last commit. This can&rsquo;t be undone.
            </p>
            <ul>
              {entry.files.map((file) => {
                const flagged = overlapping.has(file.path);
                return (
                  <li key={file.path} data-flagged={flagged || undefined}>
                    {flagged && <WarningCircle size={12} />}
                    <span>{file.path}</span>
                    {flagged && (
                      <em>also edited by a later turn; discarding here removes that too</em>
                    )}
                  </li>
                );
              })}
            </ul>
            {overlapCount > 0 && (
              <p className={styles.confirmWarning}>
                {overlapCount} of these {overlapCount === 1 ? "file was" : "files were"} also
                changed after this turn.
              </p>
            )}
          </div>
        }
        confirmLabel="Discard"
        onConfirm={() => {
          void useScmStore.getState().discardPaths(entry.files.map((file) => file.path));
          setOpen(false);
        }}
      />
    </>
  );
}

function TurnRow({ entry, overlapping }: { entry: TurnEntry; overlapping: Set<string> }) {
  return (
    <div className={styles.turn}>
      <div className={styles.turnHeader}>
        <span className={styles.turnTime}>
          {entry.completedAtMs != null
            ? relativeTime(new Date(entry.completedAtMs).toISOString())
            : "unknown time"}
        </span>
        <DiscardTurnButton entry={entry} overlapping={overlapping} />
      </div>
      <div className={styles.files}>
        {entry.files.map((file) => {
          const { name, dir } = splitPath(file.path);
          const { glyph, color } = glyphFor(file.kind);
          const flagged = overlapping.has(file.path);
          return (
            <div className={styles.file} key={file.path} data-flagged={flagged || undefined}>
              <span className={styles.fileName}>{name}</span>
              {dir && <span className={styles.filePath}>{dir}</span>}
              {flagged && (
                <Tooltip label="Also changed by a later turn" side="left">
                  <WarningCircle size={12} color="var(--yellow)" />
                </Tooltip>
              )}
              <span className={styles.statusGlyph} style={{ color }}>
                {glyph}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Per-worktree, per-agent-session history of which files each *turn*
 * changed — not just what's currently dirty (the SCM panel's job), but
 * which turn caused it, so a run gone sideways can be rolled back to
 * before it, one turn at a time. Only ever shows turns with at least one
 * still-uncommitted file: the moment every file a turn touched is
 * committed, that turn simply drops out of the list — it's git's history
 * to own from there. */
export function AgentChangesPanel() {
  const activeWorktree = useActiveWorktree();
  const worktreeRoot = activeWorktree?.path;
  const tabs = useTabsStore((s) => s.tabs);
  const byRunId = useAgentSessionStore((s) => s.byRunId);
  // Not read directly — its identity changing is this panel's cue that
  // the live git status underlying every turn's file list may have
  // moved, via the same `scm://` filesystem-watcher channel the SCM
  // panel itself refreshes from (`scmStore.ts`), rather than this panel
  // polling git on its own.
  const gitStatus = useScmStore((s) => s.status);

  const [entries, setEntries] = useState<TurnEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // No state to reset here: this component is remounted fresh
    // (`ExplorerSidebar.tsx`'s `key={activeWorktree?.id}`) on every
    // worktree switch, so "no worktree" is only ever this mount's first
    // render, never a transition an already-rendered `entries`/`loaded`
    // needs clearing for — the `!worktreeRoot` branch below reads neither.
    if (!worktreeRoot) return;
    const agentTabs = tabs.filter((t) => t.type === "agent" && t.worktreeRoot === worktreeRoot);
    let live = true;
    void (async () => {
      const results: TurnEntry[] = [];
      for (const tab of agentTabs) {
        const state = byRunId[tab.id];
        if (!state) continue;
        for (const { turnItems, complete } of completedTurns(state.items)) {
          const files = await computeTurnFileChanges(worktreeRoot, turnItems);
          if (files.length === 0) continue;
          results.push({
            key: complete.id,
            runId: tab.id,
            tabTitle: tab.title,
            agentKind: tab.agentKind ?? "claudeCode",
            seq: turnSeq(complete.id),
            completedAtMs: complete.completedAtMs,
            files,
          });
        }
      }
      if (!live) return;
      setEntries(results);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [tabs, byRunId, worktreeRoot, gitStatus]);

  // A file's *last* turn to touch it, worktree-wide — anything earlier
  // that also touched the same still-dirty path gets flagged in that
  // earlier turn's own list (see `DiscardTurnButton`'s comment).
  const latestSeqForPath = new Map<string, number>();
  for (const entry of entries) {
    for (const file of entry.files) {
      const prior = latestSeqForPath.get(file.path) ?? -1;
      if (entry.seq > prior) latestSeqForPath.set(file.path, entry.seq);
    }
  }
  const overlappingFor = (entry: TurnEntry): Set<string> =>
    new Set(
      entry.files
        .map((file) => file.path)
        .filter((path) => (latestSeqForPath.get(path) ?? -1) > entry.seq),
    );

  const runOrder = [...new Set(entries.map((entry) => entry.runId))].sort((a, b) => {
    const aMax = Math.max(...entries.filter((e) => e.runId === a).map((e) => e.seq));
    const bMax = Math.max(...entries.filter((e) => e.runId === b).map((e) => e.seq));
    return bMax - aMax;
  });

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>
          Agent Changes · {activeWorktree?.branch ?? "no worktree selected"}
        </span>
      </div>
      {!worktreeRoot ? (
        <div className={styles.empty}>No worktree selected.</div>
      ) : !loaded ? (
        <div className={styles.empty}>Loading…</div>
      ) : runOrder.length === 0 ? (
        <div className={styles.empty}>No uncommitted changes from an agent yet.</div>
      ) : (
        <div className={styles.scroller}>
          {runOrder.map((runId) => {
            const runEntries = entries
              .filter((entry) => entry.runId === runId)
              .sort((a, b) => b.seq - a.seq);
            const first = runEntries[0];
            return (
              <div className={styles.run} key={runId}>
                <div className={styles.runHeader}>
                  <AgentBrandIcon kind={first.agentKind} size={13} color="var(--accent)" />
                  <span className={styles.runTitle}>{first.tabTitle}</span>
                  <span className={styles.runKind}>{AGENT_DISPLAY_NAME[first.agentKind]}</span>
                </div>
                {runEntries.map((entry) => (
                  <TurnRow key={entry.key} entry={entry} overlapping={overlappingFor(entry)} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
