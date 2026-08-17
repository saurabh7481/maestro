import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowsClockwise,
  ClockCounterClockwise,
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  PencilSimple,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { agentsApi } from "../../api/agents";
import { gitApi } from "../../api/git";
import {
  useAgentAvailabilityStore,
  useAgentCapabilities,
} from "../../state/agentAvailabilityStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import type { TranscriptItem } from "../../state/agentSessionStore";
import type { Tab } from "../../state/tabsStore";
import { AGENT_DISPLAY_NAME, isReady } from "../../types/agent";
import type { AgentKind, PermissionMode, ResumableSession } from "../../types/agent";
import { relativeTime } from "../../design/relativeTime";
import { Switch } from "../primitives";
import { AgentComposer } from "./AgentComposer";
import { AgentBrandIcon } from "./AgentBrandIcon";
import { AgentMarkdown } from "./AgentMarkdown";
import { FileChangeReceipt } from "./FileChangeReceipt";
import { ProcessingCard } from "./ProcessingCard";
import { TurnFooter } from "./TurnFooter";
import { PlanCard } from "./PlanCard";
import { buildResponseBlocks, turnCompletion } from "./processingBlocks";
import { contextUsage } from "./turnMetrics";
import styles from "./AgentTab.module.css";

type Group =
  | { role: "user"; text: string; key: string }
  | { role: "assistant"; items: TranscriptItem[]; key: string };

/** Rough starting height for an unmeasured transcript row. Only affects
 * the scrollbar before a row has been on screen once; every row that
 * renders is measured for real via `measureElement`. */
const ESTIMATED_GROUP_HEIGHT = 180;

/** How close to the bottom counts as "following along", in pixels. Above
 * this the user is reading scrollback and must not be yanked down. */
const PIN_THRESHOLD_PX = 80;

function groupItems(items: TranscriptItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ role: "user", text: item.text, key: item.id });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.role === "assistant") {
      last.items.push(item);
    } else {
      groups.push({ role: "assistant", items: [item], key: item.id });
    }
  }
  return groups;
}

/** `groupItems` rebuilds every group object from scratch, so a single
 * streamed event handed every row in the transcript brand-new props and
 * defeated `memo` entirely. This re-uses the previous render's object for
 * any group whose contents are unchanged, which — since a turn appends to
 * the tail and `toolResult` patches one card — is very nearly all of them.
 *
 * Indices are compared independently (not stopping at the first
 * difference): a group's content doesn't depend on its neighbours, and
 * `key` equality already guarantees the two indices refer to the same
 * logical group. See docs/PERFORMANCE_AUDIT.md §1.3. */
function reuseUnchangedGroups(next: Group[], previous: Group[]): void {
  for (let i = 0; i < next.length; i++) {
    const fresh = next[i];
    const prior = previous[i];
    if (!prior || prior.key !== fresh.key || prior.role !== fresh.role) continue;
    if (fresh.role === "user" && prior.role === "user") {
      if (prior.text === fresh.text) next[i] = prior;
      continue;
    }
    if (fresh.role === "assistant" && prior.role === "assistant") {
      const unchanged =
        prior.items.length === fresh.items.length &&
        fresh.items.every((item, j) => item === prior.items[j]);
      if (unchanged) next[i] = prior;
    }
  }
}

function useStableGroups(items: TranscriptItem[]): Group[] {
  // State rather than a ref, and updated during render rather than in an
  // effect: refs must not be read during render, and an effect would
  // publish the reconciled groups a commit late — every row would render
  // once with fresh identities before settling, which is exactly the
  // re-render this is meant to avoid. This is React's documented
  // "adjusting state when a prop changes" pattern; the returned value is
  // correct on the first pass, so nothing renders stale.
  const [cache, setCache] = useState<{ items: TranscriptItem[]; groups: Group[] }>({
    items: [],
    groups: [],
  });

  if (cache.items !== items) {
    const next = groupItems(items);
    reuseUnchangedGroups(next, cache.groups);
    setCache({ items, groups: next });
    return next;
  }
  return cache.groups;
}

function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One transcript row. `memo`'d so a streamed event only re-renders the
 * group it actually touched — paired with `useStableGroups` above, which
 * is what makes the memo bite. */
const TranscriptGroup = memo(function TranscriptGroup({
  group,
  kind,
  runId,
  isNewest,
  worktreeId,
  worktreeRoot,
  active,
  turnStartedAtMs,
  totalCostUsd,
  onEdit,
  planExitTool,
  onApprovePlan,
}: {
  group: Group;
  kind: AgentKind;
  runId: string;
  isNewest: boolean;
  worktreeId?: string;
  worktreeRoot?: string;
  active: boolean;
  turnStartedAtMs: number | null;
  totalCostUsd: number | null;
  /** Absent while a turn is running — rewinding mid-answer would race the
   * turn that is still writing to the transcript. */
  onEdit?: (itemId: string) => void;
  /** `capabilities.planExitTool`, or null where the provider has none. */
  planExitTool?: string | null;
  onApprovePlan?: () => void;
}) {
  if (group.role === "user") {
    return (
      <div className={`${styles.row} ${styles.userRow}`} data-newest={isNewest || undefined}>
        <div className={styles.userMessage}>
          <div className={`${styles.roleLabel} ${styles.userRoleLabel}`}>You</div>
          <div className={styles.userText}>
            {/* Trimmed, and in its own inline wrapper: `pre-wrap` renders a
                trailing newline as a real line, whose selection highlight
                painted an empty band across the bubble's full width. */}
            <span className={styles.userTextBody}>{group.text.trim()}</span>
            {onEdit && (
              <button
                type="button"
                className={styles.editMessage}
                onClick={() => onEdit(group.key)}
                title="Edit this message and re-run from here"
                aria-label="Edit this message"
              >
                <PencilSimple size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  const blocks = buildResponseBlocks(group.items, active, planExitTool);
  const completion = turnCompletion(group.items);
  return (
    <div className={`${styles.row} ${styles.assistantRow}`} data-newest={isNewest || undefined}>
      <div className={`${styles.avatar} mo-gradient-mark`}>
        <AgentBrandIcon kind={kind} size={13} color="#0a0c11" />
      </div>
      <div className={styles.assistantMessage}>
        <div className={styles.roleLabel}>{AGENT_DISPLAY_NAME[kind]}</div>
        <div className={styles.assistantGroup}>
          {blocks.map((block) => {
            if (block.kind === "text") {
              return (
                <AgentMarkdown
                  key={block.item.id}
                  text={block.item.text}
                  streaming={block.item.streaming}
                />
              );
            }
            if (block.kind === "error") {
              return (
                <div className={styles.inlineError} key={block.item.id}>
                  {block.item.message}
                </div>
              );
            }
            if (block.kind === "plan") {
              return (
                <PlanCard
                  key={block.item.id}
                  item={block.item}
                  canApprove={!!onApprovePlan && !active}
                  onApprove={() => onApprovePlan?.()}
                />
              );
            }
            return (
              <ProcessingCard
                key={block.key}
                runId={runId}
                items={block.items}
                active={block.active}
                turnStartedAtMs={turnStartedAtMs}
              />
            );
          })}
          {completion && worktreeId && worktreeRoot && (
            <FileChangeReceipt
              receiptId={group.key}
              items={group.items}
              worktreeId={worktreeId}
              worktreeRoot={worktreeRoot}
            />
          )}
          {completion && <TurnFooter completion={completion} totalCostUsd={totalCostUsd} />}
        </div>
      </div>
    </div>
  );
});

function NotReadyCard({ title, detail }: { title: string; detail: string | null | undefined }) {
  return (
    <div className={styles.notReady}>
      <WarningCircle size={32} color="var(--yellow)" />
      <div className={styles.notReadyTitle}>{title}</div>
      {detail && <div className={styles.notReadyDetail}>{detail}</div>}
    </div>
  );
}

/** Lists this tab's agent kind's resumable sessions (Claude Code, Cursor
 * Agent — Codex has no on-disk session layout Maestro can read yet, see
 * `sessions.rs`) and, on pick, both switches the backend run to that
 * session (`resume_agent_session`) and hydrates the visible transcript
 * from its history (`get_session_transcript`) — resuming "for real" the
 * CLI's `--resume` flag already did on its own, not just cosmetically. */
function ResumeSessionPicker({
  runId,
  kind,
  worktreeId,
  worktreeRoot,
  onResumed,
  disabled,
}: {
  runId: string;
  kind: AgentKind;
  worktreeId: string;
  worktreeRoot: string;
  onResumed: () => void;
  disabled: boolean;
}) {
  const [sessions, setSessions] = useState<ResumableSession[] | null>(null);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const resumeSession = useAgentSessionStore((s) => s.resumeSession);

  useEffect(() => {
    // `kind`/`worktreeRoot` are stable for a tab's lifetime in practice
    // (fixed props off `tab`), so this effect only ever really runs once
    // per mount — the `null` initial state already covers the loading
    // case, no need to reset it here too.
    let cancelled = false;
    void agentsApi
      .listAllResumableSessions(kind)
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSessions = (sessions ?? []).filter((session) =>
    `${session.title} ${session.worktreeRoot} ${session.sessionId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

  async function resume(session: ResumableSession) {
    setResumingId(session.sessionId);
    try {
      await agentsApi.resumeAgentSession(runId, worktreeId, worktreeRoot, kind, session.sessionId);
      const turns = await agentsApi.getSessionTranscript(
        kind,
        session.worktreeRoot,
        session.sessionId,
      );
      resumeSession(runId, session.sessionId, turns);
      onResumed();
    } finally {
      setResumingId(null);
    }
  }

  return (
    <div className={styles.resumeSection}>
      <div className={styles.resumeHeading}>
        <div>
          <div className={styles.resumeLabel}>Sessions</div>
          <div className={styles.resumeHint}>Continue any {AGENT_DISPLAY_NAME[kind]} session</div>
        </div>
        {sessions && <span className={styles.sessionCount}>{sessions.length}</span>}
      </div>
      {sessions === null && (
        <div className={styles.resumeStatus}>
          <ArrowsClockwise size={12} className="mo-spin" />
          Loading sessions…
        </div>
      )}
      {loadError && <div className={styles.resumeError}>Couldn’t load sessions: {loadError}</div>}
      {sessions && sessions.length > 0 && (
        <>
          <label className={styles.sessionSearch}>
            <MagnifyingGlass size={14} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, folder, or session ID"
              aria-label="Search sessions"
            />
          </label>
          {disabled && (
            <div className={styles.resumeNotice}>Stop the current response before switching.</div>
          )}
          <div className={styles.sessionList}>
            {visibleSessions.length === 0 ? (
              <div className={styles.resumeStatus}>No sessions match “{query}”.</div>
            ) : (
              visibleSessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  className={styles.resumeRow}
                  disabled={disabled || resumingId !== null}
                  onClick={() => void resume(session)}
                >
                  <ClockCounterClockwise size={15} className={styles.resumeIcon} />
                  <div className={styles.resumeRowText}>
                    <div className={styles.resumeRowTitle}>{session.title}</div>
                    <div className={styles.resumeRowMeta}>
                      <span>{relativeTime(session.lastActiveAt)}</span>
                      <span>{session.turnCount} turns</span>
                      {session.worktreeRoot && (
                        <span className={styles.sessionPath} title={session.worktreeRoot}>
                          <FolderSimple size={11} />
                          {folderName(session.worktreeRoot)}
                        </span>
                      )}
                    </div>
                  </div>
                  {resumingId === session.sessionId ? (
                    <ArrowsClockwise size={13} className="mo-spin" />
                  ) : (
                    <span className={styles.resumeAction}>Resume</span>
                  )}
                </button>
              ))
            )}
          </div>
        </>
      )}
      {sessions?.length === 0 && (
        <div className={styles.resumeStatus}>
          No saved {AGENT_DISPLAY_NAME[kind]} sessions found.
        </div>
      )}
    </div>
  );
}

/** The virtualized conversation. Split out of `AgentTab` so the header,
 * settings panel, and composer don't re-render with it, and so the
 * virtualizer's hooks aren't behind `AgentTab`'s early returns for the
 * not-installed / not-authenticated states. */
function Transcript({
  groups,
  kind,
  runId,
  working,
  active,
  worktreeId,
  worktreeRoot,
  turnStartedAtMs,
  totalCostUsd,
  onEdit,
  planExitTool,
  onApprovePlan,
}: {
  groups: Group[];
  kind: AgentKind;
  runId: string;
  working: boolean;
  active: boolean;
  worktreeId?: string;
  worktreeRoot?: string;
  turnStartedAtMs: number | null;
  totalCostUsd: number | null;
  onEdit?: (itemId: string) => void;
  planExitTool?: string | null;
  onApprovePlan?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the user is following the bottom of the conversation. Held in
   * a ref, not state — it's read by effects and never rendered, so making
   * it state would re-render the transcript on every scroll event. */
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  /** The `scrollTop` this component last assigned, so the `scroll` event
   * it provokes can be told apart from a real one. Without this, a turn
   * that streams in faster than rows are measured unpinned itself: the
   * event from our own `scrollTop = scrollHeight` was delivered *after*
   * the next chunk had already grown the sizer, so the handler measured a
   * gap to the bottom that the user never created and concluded they had
   * scrolled away — auto-follow then stopped for the rest of the turn. */
  const scrolledToRef = useRef(-1);
  /** The window of rendered rows, watched for height changes — see the
   * `ResizeObserver` below. */
  const contentRef = useRef<HTMLDivElement>(null);
  /** Mirrors `pinnedRef` for rendering only. Kept as a separate piece of
   * state, and set only when the value actually flips, so scrolling still
   * doesn't re-render the transcript on every frame — the reason
   * `pinnedRef` is a ref in the first place. */
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_GROUP_HEIGHT,
    getItemKey: (index) => groups[index].key,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const top = element.scrollTop;
    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    // Our own scroll — leave the pin alone (see `scrolledToRef`). Only
    // what the user does to the scrollbar decides whether they're
    // following the conversation.
    if (Math.abs(top - scrolledToRef.current) < 1) return;
    scrolledToRef.current = -1;
    // Moving *toward* the bottom never unpins: that's either the smooth
    // "jump to latest" animation still in flight or someone catching up,
    // and neither means "I'm reading scrollback".
    const nearBottom = element.scrollHeight - top - element.clientHeight < PIN_THRESHOLD_PX;
    const pinned = nearBottom || (top > previousTop && pinnedRef.current);
    pinnedRef.current = pinned;
    setShowJumpToBottom((shown) => (shown === !pinned ? shown : !pinned));
  }, []);

  const jumpToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    pinnedRef.current = true;
    setShowJumpToBottom(false);
  }, []);

  // Follow the bottom, but only while the user is actually there.
  // `behavior: "smooth"` used to be used here on every appended item, so a
  // streaming turn queued overlapping scroll animations — jank, and it
  // fought anyone trying to read back through the conversation.
  const followBottom = useCallback(() => {
    const element = scrollRef.current;
    // A hidden tab is `display: none`, where every metric reads 0 —
    // "following" a background transcript would just park it at 0 and
    // clobber the position the activation effect below restores.
    if (!element || !pinnedRef.current || element.clientHeight === 0) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
    scrolledToRef.current = element.scrollTop;
  }, []);

  // Once per render that could have moved the bottom. `totalSize` is a
  // dependency because rows are measured after they render, so the real
  // bottom moves for a frame or two after each append; `lastGroup` is one
  // too, because a streaming answer grows the *final* group in place, which
  // leaves `groups.length` untouched.
  const lastGroup = groups[groups.length - 1];
  useLayoutEffect(() => {
    if (!active) return;
    followBottom();
  }, [groups.length, lastGroup, totalSize, working, active, followBottom]);

  // …and again whenever the rendered rows actually change height, which is
  // the moment that matters and is *not* the moment React re-renders: the
  // effect above runs while the virtualizer still reports the previous
  // measurements, so between an append and its measurement the transcript
  // sat one chunk behind — visibly, for a fast-streaming turn.
  // `isEmpty` is a dependency only because the empty transcript renders a
  // different tree, with no window element to observe.
  const isEmpty = groups.length === 0;
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(followBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [followBottom, isEmpty]);

  // A hidden tab is `display: none` (see `TabHost`), which zeroes the
  // scroll container's own scrollTop. Restore the position — or the
  // bottom, if that's where they were — before the browser paints the
  // newly-visible tab, so switching back never lands somewhere arbitrary.
  useLayoutEffect(() => {
    if (!active) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = pinnedRef.current ? element.scrollHeight : lastScrollTopRef.current;
    scrolledToRef.current = element.scrollTop;
  }, [active]);

  if (isEmpty) {
    return (
      <div className={styles.transcriptViewport}>
        <div className={styles.transcript} ref={scrollRef}>
          <div className={styles.empty}>
            <AgentBrandIcon kind={kind} size={26} color="var(--accent)" />
            <span>Send a message to start working with {AGENT_DISPLAY_NAME[kind]}.</span>
          </div>
        </div>
      </div>
    );
  }

  const lastIndex = groups.length - 1;

  return (
    // The scroll container is wrapped rather than positioned itself: an
    // overlay placed inside a scrolling element scrolls away with the
    // content, which is precisely what "jump to latest" must not do.
    <div className={styles.transcriptViewport}>
      <div className={styles.transcript} ref={scrollRef} onScroll={onScroll}>
        <div className={styles.transcriptSizer} style={{ height: totalSize }}>
          <div
            className={styles.transcriptWindow}
            ref={contentRef}
            style={{ transform: `translateY(${virtualItems[0]?.start ?? 0}px)` }}
          >
            {virtualItems.map((virtualItem) => {
              const group = groups[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className={styles.transcriptRow}
                  // The transcript's vertical breathing room lives on the
                  // first and last rows rather than as padding on the scroll
                  // container: padding there would offset every item from the
                  // virtualizer's coordinate space, which is what
                  // `scrollMargin` exists to correct. Folding it into the
                  // measured rows keeps one source of truth for offsets.
                  data-first={virtualItem.index === 0 || undefined}
                  data-last={virtualItem.index === lastIndex || undefined}
                >
                  <TranscriptGroup
                    group={group}
                    kind={kind}
                    runId={runId}
                    isNewest={virtualItem.index === lastIndex}
                    worktreeId={worktreeId}
                    worktreeRoot={worktreeRoot}
                    active={
                      working && virtualItem.index === lastIndex && group.role === "assistant"
                    }
                    turnStartedAtMs={turnStartedAtMs}
                    totalCostUsd={totalCostUsd}
                    onEdit={onEdit}
                    planExitTool={planExitTool}
                    onApprovePlan={onApprovePlan}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {working && groups[lastIndex]?.role === "user" && (
          <div className={styles.workingRow}>
            <div className={`${styles.row} ${styles.assistantRow}`}>
              <div className={`${styles.avatar} mo-gradient-mark`}>
                <AgentBrandIcon kind={kind} size={13} color="#0a0c11" />
              </div>
              <div className={styles.assistantMessage}>
                <ProcessingCard runId={runId} items={[]} active turnStartedAtMs={turnStartedAtMs} />
              </div>
            </div>
          </div>
        )}
      </div>
      {showJumpToBottom && (
        <button type="button" className={styles.jumpToBottom} onClick={jumpToBottom}>
          <ArrowDown size={13} />
          Jump to latest
        </button>
      )}
    </div>
  );
}

export function AgentTab({ tab, active }: { tab: Tab; active: boolean }) {
  const runId = tab.id;
  const kind = tab.agentKind ?? "claudeCode";
  const status = useAgentAvailabilityStore((s) => s.statusByKind[kind]);
  const loaded = useAgentAvailabilityStore((s) => s.loaded);

  const openRun = useAgentSessionStore((s) => s.openRun);
  const tabState = useAgentSessionStore((s) => s.byRunId[runId]);
  const appendUserMessage = useAgentSessionStore((s) => s.appendUserMessage);
  const markStarted = useAgentSessionStore((s) => s.markStarted);
  const setTurnBaseline = useAgentSessionStore((s) => s.setTurnBaseline);
  const setRunError = useAgentSessionStore((s) => s.setRunError);
  const setStoredPermissionMode = useAgentSessionStore((s) => s.setPermissionMode);
  const clearRunError = useAgentSessionStore((s) => s.clearRunError);
  const hydrateRun = useAgentSessionStore((s) => s.hydrateRun);
  const beginEditing = useAgentSessionStore((s) => s.beginEditing);
  const truncateFrom = useAgentSessionStore((s) => s.truncateFrom);
  const capabilities = useAgentCapabilities(kind);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const permissionMode: PermissionMode = tabState?.permissionMode ?? "manual";
  const working = tabState?.status === "working";
  // The turn is over and the process is gone — the run is just holding for
  // an Approve/Deny. The composer stays usable so the user can redirect the
  // agent instead of being forced to answer the card.
  const awaitingPermission = tabState?.status === "awaitingPermission";

  useEffect(() => {
    openRun(runId);
  }, [runId, openRun]);

  // Bring back the conversation this tab had before the app was last
  // closed. The child processes don't survive a quit (they're killed on
  // `ExitRequested`), so without this a restored agent tab came back
  // completely blank, which reads as lost work rather than a restart.
  useEffect(() => {
    void hydrateRun(runId, {
      kind,
      worktreeId: tab.worktreeId ?? "",
      worktreeRoot: tab.worktreeRoot ?? "",
    });
  }, [runId, kind, tab.worktreeId, tab.worktreeRoot, hydrateRun]);

  const items = useMemo(() => tabState?.items ?? [], [tabState?.items]);
  const groups = useStableGroups(items);

  async function handleSend(
    text: string,
    model: string | null,
    effort: string | null,
    fast: boolean,
  ) {
    if (tab.worktreeRoot) {
      try {
        const [gitStatus, commits] = await Promise.all([
          gitApi.getWorkingStatus(tab.worktreeRoot),
          gitApi.getCommitLog(tab.worktreeRoot, 1, 0),
        ]);
        setTurnBaseline(
          runId,
          commits[0]?.hash ?? null,
          gitStatus.entries.map((entry) => entry.path),
        );
      } catch {
        setTurnBaseline(runId, null, []);
      }
    }
    appendUserMessage(runId, text);
    try {
      if (!tabState?.started) {
        markStarted(runId);
        await agentsApi.startAgentSession({
          runId,
          worktreeId: tab.worktreeId ?? "",
          worktreeRoot: tab.worktreeRoot ?? "",
          kind,
          resumeSessionId: tab.resumeSessionId ?? null,
          forkSession: tab.forkSession ?? false,
          firstMessage: text,
          model,
          effort,
          fast,
          permissionMode,
        });
      } else {
        await agentsApi.sendAgentMessage(runId, text);
      }
    } catch (error) {
      setRunError(runId, `Agent could not continue: ${String(error)}`);
    }
  }

  // Flush one queued message as soon as the agent is free. Deliberately
  // one per idle transition rather than a loop: each send puts the run
  // back into `working`, so the next one flushes on the next transition,
  // and the user keeps the chance to remove the rest in between.
  //
  // `awaitingPermission` and `error` are *not* idle for this purpose — a
  // queued follow-up must not silently answer a permission prompt or
  // charge into a failed run.
  /** The prompt the failed turn was answering, for the error banner's
   * Retry. Reading it back off the transcript avoids keeping a second,
   * separately-stale copy of the same string. */
  const lastUserMessage = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "user") return item.text;
    }
    return null;
  }, [items]);

  // Only shown where the provider actually reports a window — otherwise a
  // percentage would have an invented denominator.
  const context = capabilities.reportsContextWindow
    ? contextUsage(
        {
          inputTokens: tabState?.lastResult?.inputTokens ?? null,
          outputTokens: tabState?.lastResult?.outputTokens ?? null,
          cacheReadTokens: tabState?.lastResult?.cacheReadTokens ?? null,
          cacheWriteTokens: tabState?.lastResult?.cacheWriteTokens ?? null,
        },
        tabState?.lastResult?.contextWindow ?? null,
      )
    : null;

  const idle = tabState?.status === "idle";
  const hasQueued = (tabState?.queued.length ?? 0) > 0;
  const sendRef = useRef(handleSend);
  // Assigned in an effect, not during render: writing a ref while
  // rendering is unsafe under concurrent rendering (react-hooks/refs), and
  // this component already documents that trap for `cursorPos` in the
  // composer.
  useEffect(() => {
    sendRef.current = handleSend;
  });

  useEffect(() => {
    if (!idle || !hasQueued) return;
    const next = useAgentSessionStore.getState().takeQueuedMessage(runId);
    // The model/effort/fast arguments only matter for the *first* message
    // of a session (`startAgentSession`); a queued one is by definition a
    // follow-up, and `sendAgentMessage` takes its configuration from the
    // run entry the composer already syncs via `setAgentConfiguration`.
    if (next !== null) void sendRef.current(next, null, null, false);
  }, [idle, hasQueued, runId]);

  /** Rewinds to an earlier message and re-runs from there with new text.
   *
   * Two halves, and both matter: the transcript is truncated locally, and
   * — where the CLI can branch a session — the next turn forks, so the
   * original conversation survives on disk instead of being rewritten.
   * Where it can't, the local history still rewinds but the model's own
   * context doesn't; the composer says so rather than implying a rewind
   * that didn't happen. */
  async function handleReplace(
    itemId: string,
    text: string,
    model: string | null,
    effort: string | null,
    fast: boolean,
  ) {
    truncateFrom(runId, itemId);
    if (tabState?.started && capabilities.forkSession) {
      try {
        await agentsApi.forkAgentSession(runId);
      } catch {
        // Not fatal: without the fork the edit still runs, it just
        // continues the existing session instead of branching it.
      }
    }
    await handleSend(text, model, effort, fast);
  }

  /** Accepts the plan: leaves read-only mode and tells the agent to carry
   * it out. Lands in Manual rather than Auto deliberately — approving a
   * *plan* is not the same as approving every action it will take, and
   * Manual is the mode that still asks (where the CLI can). */
  async function handleApprovePlan() {
    if (permissionMode === "plan") changePermissionMode("manual");
    await handleSend("Approved — please implement the plan above.", null, null, false);
  }

  // Esc stops the agent, matching every one of these CLIs' own
  // interactive mode. Scoped to the active tab so a background run isn't
  // cancelled by an Esc meant for something else, and `capture: false`
  // lets menus/dialogs handle their own Esc first.
  useEffect(() => {
    if (!active || !working) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void agentsApi.interruptAgent(runId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, working, runId]);

  function changePermissionMode(next: PermissionMode) {
    setStoredPermissionMode(runId, next);
    // A not-yet-started run has no backend entry. Its selected mode is
    // carried by `startAgentSession` above instead of being silently lost.
    if (tabState?.started) {
      void agentsApi
        .setPermissionMode(runId, next)
        .catch((error) => setRunError(runId, `Could not change permission mode: ${String(error)}`));
    }
  }

  if (!loaded || !status) {
    return (
      <div className={styles.tab}>
        <div className={styles.empty}>Checking {AGENT_DISPLAY_NAME[kind]}…</div>
      </div>
    );
  }
  if (!status.installed) {
    return (
      <div className={styles.tab}>
        <NotReadyCard
          title={`${AGENT_DISPLAY_NAME[kind]} isn't installed`}
          detail={
            status.authDetail ??
            `Install ${AGENT_DISPLAY_NAME[kind]} and set its binary path in Settings → Agents & CLI.`
          }
        />
      </div>
    );
  }
  if (!isReady(status)) {
    return (
      <div className={styles.tab}>
        <NotReadyCard
          title={`${AGENT_DISPLAY_NAME[kind]} needs authentication`}
          detail={status.authDetail}
        />
      </div>
    );
  }

  const errored = tabState?.status === "error";

  return (
    <div className={styles.tab}>
      <div className={styles.header}>
        <div className={`${styles.avatar} mo-gradient-mark`}>
          <AgentBrandIcon kind={kind} size={14} color="#0a0c11" />
        </div>
        <div>
          <div className={styles.title}>{AGENT_DISPLAY_NAME[kind]}</div>
          <div className={styles.subtitle}>
            {tabState?.lastResult?.sessionId.slice(0, 8) ?? "new session"}
          </div>
        </div>
        {context && (
          <div
            className={styles.contextMeter}
            title={`${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens used in the last turn`}
          >
            <span className={styles.contextBar} data-heavy={context.percent >= 75 || undefined}>
              <span style={{ width: `${context.percent}%` }} />
            </span>
            {context.percent}% context
          </div>
        )}
        <div
          className={styles.statusPill}
          data-status={errored ? "error" : awaitingPermission ? "awaiting" : undefined}
        >
          {!errored && !awaitingPermission && (
            <span className={styles.statusDot} data-active={working} />
          )}
          {errored ? "error" : awaitingPermission ? "needs approval" : working ? "working" : "idle"}
        </div>
        <div className={styles.headerActions}>
          {working && (
            <div className={styles.stopButton} onClick={() => void agentsApi.interruptAgent(runId)}>
              <Stop size={13} />
              Stop
            </div>
          )}
          <div className={styles.stopButton} onClick={() => setSettingsOpen((v) => !v)}>
            <GearSix size={14} />
          </div>
        </div>
      </div>

      {settingsOpen && (
        <div className={styles.settingsPanel}>
          <Switch
            label="Dangerously skip permissions"
            checked={permissionMode === "auto"}
            onCheckedChange={(v) => changePermissionMode(v ? "auto" : "manual")}
          />
          <p className={styles.settingsNote}>
            Off by default. When on, every tool call runs without an approval card — only enable
            this in a sandbox you trust. The composer's mode picker below the message box offers the
            same switch, plus a read-only Plan mode.
          </p>
          {tab.worktreeId && tab.worktreeRoot && (
            <ResumeSessionPicker
              runId={runId}
              kind={kind}
              worktreeId={tab.worktreeId}
              worktreeRoot={tab.worktreeRoot}
              onResumed={() => setSettingsOpen(false)}
              disabled={working}
            />
          )}
        </div>
      )}

      {errored && tabState?.errorMessage && (
        <div className={styles.errorBanner} role="alert">
          <span className={styles.errorText}>{tabState.errorMessage}</span>
          {lastUserMessage && (
            <button
              type="button"
              className={styles.errorAction}
              // Re-sends the message the failed turn was working on, so a
              // transient crash doesn't cost the user their prompt.
              onClick={() => void handleSend(lastUserMessage, null, null, false)}
            >
              <ArrowClockwise size={13} />
              Retry
            </button>
          )}
          <button
            type="button"
            className={styles.errorAction}
            onClick={() => clearRunError(runId)}
            aria-label="Dismiss error"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <Transcript
        groups={groups}
        kind={kind}
        runId={runId}
        working={working}
        active={active}
        worktreeId={tab.worktreeId}
        worktreeRoot={tab.worktreeRoot}
        turnStartedAtMs={tabState?.turnStartedAtMs ?? null}
        totalCostUsd={tabState?.lastResult?.totalCostUsd ?? null}
        onEdit={working ? undefined : (itemId) => beginEditing(runId, itemId)}
        planExitTool={capabilities.planExitTool}
        onApprovePlan={handleApprovePlan}
      />

      <AgentComposer
        runId={runId}
        kind={kind}
        worktreeRoot={tab.worktreeRoot ?? ""}
        disabled={working}
        locked={!!tabState?.started}
        permissionMode={permissionMode}
        onPermissionModeChange={changePermissionMode}
        onSend={handleSend}
        onReplace={handleReplace}
      />
    </div>
  );
}
