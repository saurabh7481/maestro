import { create } from "zustand";
import { agentsApi } from "../api/agents";
import { listenToAgentEvents } from "../api/agentEvents";
import type { AgentEvent, LastResultPayload, TranscriptTurn } from "../types/agent";
import { useTabsStore } from "./tabsStore";
import { useToastStore, isAppFocused } from "./toastStore";
import type { ToastTone } from "./toastStore";
import { useNotificationHistoryStore } from "./notificationHistoryStore";
import { sendOsNotification } from "../design/osNotifications";

/** A run's tab is "backgrounded" if it's not the active tab, or the whole
 * app window doesn't have OS focus — either way the transcript update
 * that just happened isn't something the user is currently looking at,
 * so it's worth a toast rather than relying on them to notice. Always
 * logged to the notification-history bell (`NotificationPopover.tsx`) too;
 * an OS-level desktop notification only fires when the window itself has
 * lost focus — a backgrounded tab in a focused window already has the
 * toast, and popping an OS notification over an app the user is actively
 * looking at would be redundant noise. */
function notifyIfBackgrounded(runId: string, tone: ToastTone, title: string): void {
  const { tabs, activeTabId } = useTabsStore.getState();
  if (activeTabId === runId && isAppFocused()) return;
  const tab = tabs.find((t) => t.id === runId);
  const description = tab?.title;
  useToastStore.getState().push({ tone, title, description });
  useNotificationHistoryStore.getState().push({ tone, title, description, runId });
  if (!isAppFocused()) sendOsNotification(title, description);
}

/** A stable, module-scoped empty array for `queueByRunId[id] ?? EMPTY_QUEUE`-
 * style selectors — never `?? []`. A fresh `[]` literal as a selector's
 * fallback returns a new reference on every read, which
 * `useSyncExternalStore` (what zustand's hook is built on) treats as
 * "the subscribed value changed" on every single store notification, not
 * just ones that actually touch this run's queue — re-render, re-select,
 * new `[]` again, forever. Same trap `workspaceStore.ts`'s
 * `EMPTY_WORKTREES` and `agentAvailabilityStore.ts`'s `useReadyAgentKinds`
 * already document. */
export const EMPTY_QUEUE: string[] = [];

export type PermissionState =
  /** Waiting on the user — the turn has stopped and only an answer restarts it. */
  | { status: "pending"; message: string }
  /** The CLI refused the call under its own rules and carried on without
   * asking. Nothing is waiting for the user, so this renders as an
   * explanation rather than an Approve/Deny card. */
  | { status: "blocked"; message: string }
  | { status: "approved" }
  | { status: "denied" };

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  /** `streaming` marks the one text item currently being typed out by a
   * delta-capable provider. At most one is open per run at a time; it
   * closes when the provider sends the finished block, when the turn
   * ends, or when any other kind of item follows it. */
  | { id: string; kind: "assistantText"; text: string; streaming?: boolean }
  /** `elapsedMs` is measured here, not reported by any CLI: none of them
   * puts a duration on a thinking block. It's the wall-clock gap between
   * the previous event of this turn and this block arriving — which for a
   * thinking block is the time the model spent on it, plus request
   * latency. Approximate by construction, so it's only shown rounded to
   * the second and omitted when it would round to nothing. */
  | { id: string; kind: "thinking"; text: string; elapsedMs: number | null }
  | {
      id: string;
      kind: "toolCall";
      toolCallId: string;
      name: string;
      input: unknown;
      result?: {
        content: string;
        isError: boolean;
        diffAdded: number | null;
        diffRemoved: number | null;
      };
      permission?: PermissionState;
    }
  | { id: string; kind: "error"; message: string }
  | {
      id: string;
      kind: "turnComplete";
      baselineHead: string | null;
      baselinePaths: string[];
      durationMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      /** When this turn actually finished, for `AgentChangesPanel.tsx`'s
       * per-turn timestamps — nothing else on a turn carries a durable
       * wall-clock time (`turnStartedAtMs`/`lastEventAtMs` on
       * `AgentTabState` are transient and reset per turn). `null` for a
       * turn completed before this field existed — a restored transcript
       * from an older session simply shows no timestamp rather than a
       * fabricated one. */
      completedAtMs: number | null;
    }
  /** An event Maestro's adapter for this CLI didn't recognize and
   * forwarded verbatim rather than dropping (docs/CHECKLIST.md's "no
   * silent failure") — rendered as a small collapsed raw-JSON card
   * rather than being invisible. Expected to show up mainly for
   * `codex.rs`, whose event shapes are best-effort/unverified. */
  | { id: string; kind: "raw"; json: unknown }
  /** A transient progress note the adapter recognized (reconnect
   * attempts, backoff) — quiet status text inside the activity card,
   * never an error. Consecutive notes coalesce into one item that
   * updates in place, so six retry attempts read as one line that
   * counts up rather than six cards. */
  | { id: string; kind: "status"; text: string };

/** `awaitingPermission` is a real third resting state, not a flavour of
 * `working`: the CLI process is gone and the turn is over, but the run is
 * mid-thought and waiting on the user's Approve/Deny before it can pick up
 * where it stopped. Keeping it distinct is what stops the following `exit`
 * event from being reported as a crash.
 *
 * `settling` means the CLI reported its final result but the child process
 * has not exited yet. A follow-up cannot start until that exit releases the
 * backend's one-turn-at-a-time latch, so this must stay distinct from idle. */
export type AgentRunStatus = "idle" | "working" | "settling" | "awaitingPermission" | "error";

/** One file staged for the next message, shown as a preview chip in the
 * composer. `relPath` is worktree-relative and is what gets appended to
 * the message as an `@mention` on send — the previews are presentation,
 * not a second attachment protocol (see `commands/attachments.rs`). */
export interface ComposerAttachment {
  relPath: string;
  /** Basename, for the document card and the image's alt text. */
  name: string;
  /** Drives thumbnail vs. document card. Decided from the extension by
   * the caller; the backend independently refuses to hand back a preview
   * for anything it doesn't recognise as an image. */
  isImage: boolean;
}

export interface AgentTabState {
  items: TranscriptItem[];
  status: AgentRunStatus;
  errorMessage: string | null;
  lastResult: ({ sessionId: string } & LastResultPayload) | null;
  permissionMode: import("../types/agent").PermissionMode;
  turnStartedAtMs: number | null;
  /** When the last event of the current turn arrived, so a thinking block
   * can be dated against what came before it rather than against the
   * start of the whole turn. */
  lastEventAtMs: number | null;
  /** Whether `start_agent_session` has been called yet — determines
   * whether the next composer submit calls `startAgentSession` or
   * `sendAgentMessage`. */
  started: boolean;
  /** Messages typed while a turn was in flight, waiting for it to end.
   * None of these CLIs accepts input mid-turn (each turn is its own
   * process — see `manager.rs`), so the alternative to holding them here
   * was the composer silently discarding what the user typed. */
  queued: string[];
}

function emptyTabState(): AgentTabState {
  return {
    items: [],
    status: "idle",
    errorMessage: null,
    lastResult: null,
    permissionMode: "auto",
    turnStartedAtMs: null,
    lastEventAtMs: null,
    started: false,
    queued: [],
  };
}

/** Shared by the `appendUserMessage` action (tests, and any future
 * intentional local append) and the live `"message"` event's `role:
 * "user"` case (`AgentTab.tsx`'s composer no longer appends locally —
 * `agents/manager.rs::run_turn` echoes every real user message back over
 * the same channel it streams everything else on, so desktop and mobile
 * both render it the same way). */
function applyUserMessage(tab: AgentTabState, text: string): AgentTabState {
  // Sending a new instruction answers an outstanding permission request by
  // moving on from it. Leaving the card live would offer an Approve button
  // that resumes an action the conversation has already left behind — and
  // the tool genuinely never ran, so "denied" is the accurate record of
  // what happened to it.
  const items = tab.items.map((item) =>
    item.kind === "toolCall" && item.permission?.status === "pending"
      ? { ...item, permission: { status: "denied" } as PermissionState }
      : item,
  );
  return {
    ...tab,
    status: "working",
    errorMessage: null,
    turnStartedAtMs: Date.now(),
    lastEventAtMs: Date.now(),
    items: [...items, { id: nextId(), kind: "user", text }],
  };
}

let itemSeq = 0;
function nextId(): string {
  itemSeq += 1;
  return `item-${itemSeq}`;
}

/** The open streaming text item, if the last item is one. Streaming only
 * ever continues the tail — anything else arriving (a tool call, an error)
 * means that block of prose is finished. */
function openStreamIndex(items: TranscriptItem[]): number {
  const last = items.length - 1;
  return last >= 0 && items[last].kind === "assistantText" && items[last].streaming ? last : -1;
}

/** The most recent assistant text block in the *current* turn, even if
 * already-closed items (tool calls, thinking, raw system events) came
 * after it — a `turnComplete`/`user` item means whatever's on the other
 * side belongs to a different turn and must never be merged into. Used
 * to catch cursor-agent re-stating its whole previous block verbatim
 * before continuing (live-observed: delayed background-task
 * notifications arriving after a turn's "final" message trigger one
 * more `assistant` line whose text starts by repeating the block just
 * closed, then appends genuinely new content) — `openStreamIndex` alone
 * only catches the same-segment fragment/consolidated-resend case. */
function lastAssistantTextIndex(items: TranscriptItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const kind = items[i].kind;
    if (kind === "assistantText") return i;
    if (kind === "turnComplete" || kind === "user") return -1;
  }
  return -1;
}

/** Marks any open streaming item as finished, leaving its text as-is.
 * Returns the same array when there was nothing open, so callers don't
 * churn references (and re-render the transcript) for no reason. */
function closeStream(items: TranscriptItem[]): TranscriptItem[] {
  const index = openStreamIndex(items);
  if (index === -1) return items;
  const next = items.slice();
  const item = next[index] as Extract<TranscriptItem, { kind: "assistantText" }>;
  next[index] = { ...item, streaming: false };
  return next;
}

/** Tool output is kept whole in memory (the card can expand to show it)
 * but trimmed on the way to disk — a single `Bash` result can be
 * megabytes, and none of it is worth restoring in full a week later. */
const PERSISTED_RESULT_CHARS = 4000;

/** Keeps a very long conversation's stored copy bounded. The tail is what
 * gets restored, since that's the part anyone scrolls back to. */
const PERSISTED_ITEM_LIMIT = 400;

function forPersistence(items: TranscriptItem[]): TranscriptItem[] {
  const tail = items.length > PERSISTED_ITEM_LIMIT ? items.slice(-PERSISTED_ITEM_LIMIT) : items;
  return tail.map((item) => {
    if (item.kind !== "toolCall" || !item.result) return item;
    const { content } = item.result;
    if (content.length <= PERSISTED_RESULT_CHARS) return item;
    return {
      ...item,
      result: { ...item.result, content: `${content.slice(0, PERSISTED_RESULT_CHARS)}\n…` },
    };
  });
}

/** Throttled per run: a streaming turn touches the transcript many times a
 * second, and writing SQLite on each one would be pure waste.
 *
 * Throttled, *not* debounced. A debounce reset its timer on every touch,
 * so a turn that streamed continuously never let the timer reach its
 * deadline and never wrote at all until the stream went quiet for a full
 * interval — the persisted transcript stayed frozen at whatever it held
 * before the turn began. That was invisible on the desktop, which reads
 * from memory, and very visible on a phone, which hydrates from exactly
 * this row and so showed a conversation stuck before the reply it was
 * watching arrive. The first touch now schedules a write that actually
 * happens, and subsequent touches within the window coalesce into it. */
const persistTimers = new Map<string, number>();
const PERSIST_INTERVAL_MS = 1500;

function schedulePersist(runId: string): void {
  if (persistTimers.has(runId)) return;
  persistTimers.set(
    runId,
    window.setTimeout(() => {
      persistTimers.delete(runId);
      void persistNow(runId);
    }, PERSIST_INTERVAL_MS),
  );
}

async function persistNow(runId: string): Promise<void> {
  const tab = useAgentSessionStore.getState().byRunId[runId];
  if (!tab || tab.items.length === 0) return;
  const info = useTabsStore.getState().tabs.find((t) => t.id === runId);
  if (!info?.agentKind) return;
  const lastResult: LastResultPayload | null = tab.lastResult
    ? {
        totalCostUsd: tab.lastResult.totalCostUsd,
        durationMs: tab.lastResult.durationMs,
        inputTokens: tab.lastResult.inputTokens,
        outputTokens: tab.lastResult.outputTokens,
        cacheReadTokens: tab.lastResult.cacheReadTokens,
        cacheWriteTokens: tab.lastResult.cacheWriteTokens,
        contextWindow: tab.lastResult.contextWindow,
      }
    : null;
  try {
    await agentsApi.saveAgentTranscript(
      runId,
      info.worktreeId ?? "",
      info.agentKind,
      tab.lastResult?.sessionId ?? null,
      JSON.stringify(forPersistence(tab.items)),
      lastResult,
    );
  } catch {
    // Persistence is a convenience; a failed write must never take down
    // the conversation that triggered it.
  }
}

interface AgentSessionState {
  byRunId: Record<string, AgentTabState>;
  unlistenByRunId: Record<string, () => void>;
  /** Composer draft text, kept here (not component state) so it survives
   * switching away from an agent tab and back — `MainContent` only
   * mounts the active tab's component. */
  draftByRunId: Record<string, string>;
  setDraft: (runId: string, text: string) => void;
  /** Files staged into `.maestro/attachments/` for this run's next
   * message, shown as previews above the composer rather than as `@path`
   * text. Per-run and outside the draft string so switching tabs (or
   * editing the draft) can't lose or mangle them — the paths are still
   * appended to the message on send, which is how the agent reads them. */
  attachmentsByRunId: Record<string, ComposerAttachment[]>;
  addAttachments: (runId: string, attachments: ComposerAttachment[]) => void;
  removeAttachment: (runId: string, relPath: string) => void;
  clearAttachments: (runId: string) => void;

  /** Idempotent — sets up the `agent://{runId}/event` listener once per
   * run id. Safe to call from a component's mount effect every render. */
  openRun: (runId: string) => void;
  adoptRun: (runId: string, state: AgentTabState) => void;
  /** Restores a tab's conversation from disk after a restart, and — when
   * the CLI supports resuming — reconnects the backend to the session it
   * belongs to so the next message continues it. Idempotent and safe to
   * call from a mount effect; a run that already has items is left alone. */
  hydrateRun: (
    runId: string,
    context: { kind: import("../types/agent").AgentKind; worktreeId: string; worktreeRoot: string },
  ) => Promise<void>;
  closeRun: (runId: string) => void;
  markStarted: (runId: string) => void;
  /** Replaces a tab's transcript with a resumed session's history (see
   * `AgentTab.tsx`'s settings-panel "Resume session" list) — a fresh
   * `AgentTabState`, not a merge, since resuming genuinely swaps which
   * conversation this tab is looking at. */
  resumeSession: (runId: string, sessionId: string, turns: TranscriptTurn[]) => void;
  appendUserMessage: (runId: string, text: string) => void;
  setWorking: (runId: string) => void;
  /** Which earlier user message is being rewritten, by item id, or `null`.
   * Kept per run (not in the composer) for the same survives-remount
   * reasoning as `draftByRunId`. */
  editingByRunId: Record<string, string | null>;
  /** Loads an earlier message back into the composer for rewriting. */
  beginEditing: (runId: string, itemId: string) => void;
  cancelEditing: (runId: string) => void;
  /** Drops `itemId` and everything after it — the local half of a rewind.
   * The CLI-side half is `fork_agent_session`, where supported. */
  truncateFrom: (runId: string, itemId: string) => void;

  /** Holds a message typed mid-turn until the agent is free. */
  queueMessage: (runId: string, text: string) => void;
  /** Drops a queued message that hasn't been sent yet. */
  unqueueMessage: (runId: string, index: number) => void;
  /** Removes and returns the next queued message, if any. */
  takeQueuedMessage: (runId: string) => string | null;
  /** Settles a run that stopped without the backend having anything more
   * to say — a denial, where the turn already ended at the request. */
  setIdle: (runId: string) => void;
  setRunError: (runId: string, message: string) => void;
  /** Dismisses a failure without starting anything — the run goes back to
   * idle so the conversation can simply be continued. */
  clearRunError: (runId: string) => void;
  setPermissionMode: (runId: string, mode: import("../types/agent").PermissionMode) => void;
  setToolCallPermissionStatus: (
    runId: string,
    toolCallId: string,
    status: "approved" | "denied",
  ) => void;
  applyEvent: (runId: string, event: AgentEvent) => void;
}

export const useAgentSessionStore = create<AgentSessionState>((set, get) => ({
  byRunId: {},
  unlistenByRunId: {},
  draftByRunId: {},
  setDraft: (runId, text) => set((s) => ({ draftByRunId: { ...s.draftByRunId, [runId]: text } })),

  attachmentsByRunId: {},
  addAttachments: (runId, attachments) =>
    set((s) => {
      const existing = s.attachmentsByRunId[runId] ?? [];
      // Re-attaching the same staged file is a no-op rather than a second
      // identical chip — paste twice, or paste something already browsed
      // for, and there is still one of it.
      const merged = [...existing];
      for (const attachment of attachments) {
        if (!merged.some((a) => a.relPath === attachment.relPath)) merged.push(attachment);
      }
      return { attachmentsByRunId: { ...s.attachmentsByRunId, [runId]: merged } };
    }),
  removeAttachment: (runId, relPath) =>
    set((s) => ({
      attachmentsByRunId: {
        ...s.attachmentsByRunId,
        [runId]: (s.attachmentsByRunId[runId] ?? []).filter((a) => a.relPath !== relPath),
      },
    })),
  clearAttachments: (runId) =>
    set((s) => {
      const attachmentsByRunId = { ...s.attachmentsByRunId };
      delete attachmentsByRunId[runId];
      return { attachmentsByRunId };
    }),

  openRun: (runId) => {
    if (get().unlistenByRunId[runId]) return;
    set((s) => ({
      byRunId: { ...s.byRunId, [runId]: s.byRunId[runId] ?? emptyTabState() },
    }));
    // Registered synchronously as a placeholder so a second `openRun`
    // call before the async `listen()` resolves still short-circuits
    // above instead of double-subscribing.
    set((s) => ({ unlistenByRunId: { ...s.unlistenByRunId, [runId]: () => {} } }));
    void listenToAgentEvents(runId, (event) => get().applyEvent(runId, event)).then((unlisten) => {
      set((s) => ({ unlistenByRunId: { ...s.unlistenByRunId, [runId]: unlisten } }));
    });
  },

  /** Seeds a run's transcript from another window's copy of it — a tab
   * moved into a detached window (`chrome/satelliteWindows.ts`) would
   * otherwise show an empty transcript for a conversation that plainly
   * has history. The run's `openRun` listener still does the rest: the
   * CLI process is in Rust and keeps streaming to every window, so from
   * this point on both windows stay in step on their own. */
  adoptRun: (runId, state) => set((s) => ({ byRunId: { ...s.byRunId, [runId]: state } })),

  hydrateRun: async (runId, context) => {
    // A live run always wins: this only ever fills in a tab that came back
    // from a previous launch with nothing in it.
    if ((get().byRunId[runId]?.items.length ?? 0) > 0) return;

    let stored: Awaited<ReturnType<typeof agentsApi.loadAgentTranscript>> = null;
    try {
      stored = await agentsApi.loadAgentTranscript(runId);
    } catch {
      return;
    }
    if (!stored) return;

    let items: TranscriptItem[];
    try {
      const parsed: unknown = JSON.parse(stored.items);
      if (!Array.isArray(parsed)) return;
      items = parsed as TranscriptItem[];
    } catch {
      // Unreadable payload: start clean rather than render garbage.
      return;
    }
    if (items.length === 0) return;

    // Restored ids must not collide with ids minted this session, or React
    // keys — and the transcript's own item lookups — would alias two
    // different messages onto each other.
    items = items.map((item) => ({ ...item, id: nextId() }) as TranscriptItem);

    // Reconnecting the CLI session is what makes this a resumed
    // conversation rather than a screenshot of one. Without a session id
    // (or on a CLI that can't resume) the history still restores, but the
    // next message starts a fresh session — so `started` stays false.
    let started = false;
    if (stored.cliSessionId && context.worktreeId && context.worktreeRoot) {
      try {
        await agentsApi.resumeAgentSession(
          runId,
          context.worktreeId,
          context.worktreeRoot,
          context.kind,
          stored.cliSessionId,
        );
        started = true;
      } catch {
        // Session gone from the CLI's own store — keep the transcript,
        // let the next message open a new session.
      }
    }

    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      if (tab.items.length > 0) return s; // Raced a live turn; leave it be.
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: {
            ...tab,
            items,
            started,
            status: "idle",
            lastResult: stored.cliSessionId
              ? {
                  sessionId: stored.cliSessionId,
                  totalCostUsd: stored.lastResult?.totalCostUsd ?? null,
                  durationMs: stored.lastResult?.durationMs ?? 0,
                  inputTokens: stored.lastResult?.inputTokens ?? null,
                  outputTokens: stored.lastResult?.outputTokens ?? null,
                  cacheReadTokens: stored.lastResult?.cacheReadTokens ?? null,
                  cacheWriteTokens: stored.lastResult?.cacheWriteTokens ?? null,
                  contextWindow: stored.lastResult?.contextWindow ?? null,
                }
              : null,
          },
        },
      };
    });
  },

  closeRun: (runId) => {
    const timer = persistTimers.get(runId);
    if (timer !== undefined) window.clearTimeout(timer);
    persistTimers.delete(runId);
    void agentsApi.deleteAgentTranscript(runId).catch(() => {});
    get().unlistenByRunId[runId]?.();
    set((s) => {
      const byRunId = { ...s.byRunId };
      const unlistenByRunId = { ...s.unlistenByRunId };
      const draftByRunId = { ...s.draftByRunId };
      const attachmentsByRunId = { ...s.attachmentsByRunId };
      delete byRunId[runId];
      delete unlistenByRunId[runId];
      delete draftByRunId[runId];
      delete attachmentsByRunId[runId];
      return { byRunId, unlistenByRunId, draftByRunId, attachmentsByRunId };
    });
  },

  markStarted: (runId) => {
    set((s) => ({
      byRunId: {
        ...s.byRunId,
        [runId]: { ...(s.byRunId[runId] ?? emptyTabState()), started: true },
      },
    }));
  },

  resumeSession: (runId, sessionId, turns) => {
    const items: TranscriptItem[] = turns.map((turn) => ({
      id: nextId(),
      kind: turn.role === "user" ? "user" : "assistantText",
      text: turn.text,
    }));
    set((s) => ({
      byRunId: {
        ...s.byRunId,
        [runId]: {
          items,
          status: "idle",
          errorMessage: null,
          lastResult: {
            sessionId,
            totalCostUsd: null,
            durationMs: 0,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            contextWindow: null,
          },
          started: true,
          permissionMode: "auto",
          turnStartedAtMs: null,
          lastEventAtMs: null,
          queued: [],
        },
      },
    }));
  },

  appendUserMessage: (runId, text) => {
    schedulePersist(runId);
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return { byRunId: { ...s.byRunId, [runId]: applyUserMessage(tab, text) } };
    });
  },

  setWorking: (runId) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: {
            ...tab,
            status: "working",
            errorMessage: null,
            turnStartedAtMs: Date.now(),
            lastEventAtMs: Date.now(),
          },
        },
      };
    });
  },

  editingByRunId: {},

  beginEditing: (runId, itemId) => {
    const tab = get().byRunId[runId];
    const target = tab?.items.find((item) => item.id === itemId);
    if (!target || target.kind !== "user") return;
    set((s) => ({
      editingByRunId: { ...s.editingByRunId, [runId]: itemId },
      draftByRunId: { ...s.draftByRunId, [runId]: target.text },
    }));
  },

  cancelEditing: (runId) => {
    set((s) => ({
      editingByRunId: { ...s.editingByRunId, [runId]: null },
      draftByRunId: { ...s.draftByRunId, [runId]: "" },
    }));
  },

  truncateFrom: (runId, itemId) => {
    schedulePersist(runId);
    set((s) => {
      const tab = s.byRunId[runId];
      if (!tab) return s;
      const index = tab.items.findIndex((item) => item.id === itemId);
      if (index === -1) return s;
      return {
        byRunId: { ...s.byRunId, [runId]: { ...tab, items: tab.items.slice(0, index) } },
        editingByRunId: { ...s.editingByRunId, [runId]: null },
      };
    });
  },

  queueMessage: (runId, text) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return {
        byRunId: { ...s.byRunId, [runId]: { ...tab, queued: [...tab.queued, text] } },
      };
    });
  },

  unqueueMessage: (runId, index) => {
    set((s) => {
      const tab = s.byRunId[runId];
      if (!tab) return s;
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: { ...tab, queued: tab.queued.filter((_, i) => i !== index) },
        },
      };
    });
  },

  takeQueuedMessage: (runId) => {
    const tab = get().byRunId[runId];
    const next = tab?.queued[0];
    if (next === undefined) return null;
    set((s) => {
      const current = s.byRunId[runId];
      if (!current) return s;
      return {
        byRunId: { ...s.byRunId, [runId]: { ...current, queued: current.queued.slice(1) } },
      };
    });
    return next;
  },

  setIdle: (runId) => {
    set((s) => {
      const tab = s.byRunId[runId];
      if (!tab) return s;
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: { ...tab, status: "idle", turnStartedAtMs: null },
        },
      };
    });
  },

  setRunError: (runId, message) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: { ...tab, status: "error", errorMessage: message, turnStartedAtMs: null },
        },
      };
    });
  },

  clearRunError: (runId) => {
    set((s) => {
      const tab = s.byRunId[runId];
      if (!tab || tab.status !== "error") return s;
      return {
        byRunId: { ...s.byRunId, [runId]: { ...tab, status: "idle", errorMessage: null } },
      };
    });
  },

  setPermissionMode: (runId, mode) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return { byRunId: { ...s.byRunId, [runId]: { ...tab, permissionMode: mode } } };
    });
  },

  setToolCallPermissionStatus: (runId, toolCallId, status) => {
    set((s) => {
      const tab = s.byRunId[runId];
      if (!tab) return s;
      const items = tab.items.map((item) =>
        item.kind === "toolCall" && item.toolCallId === toolCallId
          ? { ...item, permission: { status } as PermissionState }
          : item,
      );
      return { byRunId: { ...s.byRunId, [runId]: { ...tab, items } } };
    });
  },

  applyEvent: (runId, event) => {
    // Defensive: a malformed event should be skipped, not crash the whole
    // renderer (see `api/fsEvents.ts`).
    if (!event?.type) return;
    // The end of a turn is the one moment worth writing through without
    // waiting for the debounce: it's also the likeliest moment to quit.
    if (event.type === "turnResult") window.setTimeout(() => void persistNow(runId), 0);
    else schedulePersist(runId);
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      const items = tab.items;
      const now = Date.now();
      // Anything that isn't more prose ends the streamed block it follows.
      const closed = () => closeStream(items);

      switch (event.type) {
        case "message": {
          if (event.role === "user") {
            // Echoed by `agents/manager.rs::run_turn` for every real user
            // message (not the permission-approval nudge) — the composer
            // no longer appends this locally, so both a desktop send and a
            // mobile-relay-created one render identically, from the same
            // backend-authoritative source.
            if (!event.text) return s;
            return { byRunId: { ...s.byRunId, [runId]: applyUserMessage(tab, event.text) } };
          }
          if (event.role !== "assistant" || !event.text) return s;
          // A provider that streams *and* re-sends the finished block
          // (Claude) lands here after its own deltas. Replace rather than
          // append: the block is authoritative, so this also repairs any
          // delta that was dropped, and appending would show the reply
          // twice.
          const streamIndex = openStreamIndex(items);
          if (streamIndex !== -1) {
            const next = items.slice();
            next[streamIndex] = {
              ...(next[streamIndex] as Extract<TranscriptItem, { kind: "assistantText" }>),
              text: event.text,
              streaming: false,
            };
            return { byRunId: { ...s.byRunId, [runId]: { ...tab, items: next } } };
          }
          const priorIndex = lastAssistantTextIndex(items);
          const prior =
            priorIndex !== -1
              ? (items[priorIndex] as Extract<TranscriptItem, { kind: "assistantText" }>)
              : null;
          if (prior && event.text.startsWith(prior.text)) {
            const next = items.slice();
            next[priorIndex] = { ...prior, text: event.text, streaming: false };
            return { byRunId: { ...s.byRunId, [runId]: { ...tab, items: next } } };
          }
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: [...items, { id: nextId(), kind: "assistantText", text: event.text }],
              },
            },
          };
        }
        case "messageDelta": {
          if (!event.text) return s;
          const streamIndex = openStreamIndex(items);
          if (streamIndex !== -1) {
            const next = items.slice();
            const open = next[streamIndex] as Extract<TranscriptItem, { kind: "assistantText" }>;
            next[streamIndex] = { ...open, text: open.text + event.text };
            return { byRunId: { ...s.byRunId, [runId]: { ...tab, items: next } } };
          }
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: [
                  ...items,
                  { id: nextId(), kind: "assistantText", text: event.text, streaming: true },
                ],
              },
            },
          };
        }
        case "thinking": {
          const since = tab.lastEventAtMs ?? tab.turnStartedAtMs;
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                lastEventAtMs: now,
                items: [
                  ...closed(),
                  {
                    id: nextId(),
                    kind: "thinking",
                    text: event.text,
                    elapsedMs: since === null ? null : now - since,
                  },
                ],
              },
            },
          };
        }
        case "toolCall":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                lastEventAtMs: now,
                items: [
                  ...closed(),
                  {
                    id: nextId(),
                    kind: "toolCall",
                    toolCallId: event.id,
                    name: event.name,
                    input: event.input,
                  },
                ],
              },
            },
          };
        case "toolResult":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: items.map((item) =>
                  item.kind === "toolCall" && item.toolCallId === event.toolUseId
                    ? {
                        ...item,
                        result: {
                          content: event.content,
                          isError: event.isError,
                          diffAdded: event.diffAdded,
                          diffRemoved: event.diffRemoved,
                        },
                      }
                    : item,
                ),
              },
            },
          };
        case "permissionDenied":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: items.map((item) =>
                  item.kind === "toolCall" && item.toolCallId === event.toolUseId
                    ? {
                        ...item,
                        permission: {
                          status: event.gated ? "pending" : "blocked",
                          message: event.message,
                        },
                      }
                    : item,
                ),
              },
            },
          };
        case "awaitingPermission":
          // The backend stopped the child on purpose. Park the run here so
          // the composer unlocks, the spinner stops, and the `exit` that
          // follows isn't mistaken for the process dying mid-turn.
          notifyIfBackgrounded(runId, "info", "Agent needs your approval");
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                status: "awaitingPermission",
                errorMessage: null,
                turnStartedAtMs: null,
              },
            },
          };
        case "turnResult":
          notifyIfBackgrounded(
            runId,
            event.isError ? "error" : "success",
            event.isError ? "Agent stopped with an error" : "Agent finished",
          );
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                // stdout can close before the process itself exits (notably
                // with Cursor Agent). Keep the run unavailable until the
                // following `exit`; otherwise a queued follow-up races the
                // backend latch and that old exit can be mistaken for the
                // new turn crashing.
                status: "settling",
                errorMessage: event.isError
                  ? (event.resultText ?? "The agent reported that this turn failed.")
                  : null,
                items: [
                  ...closed(),
                  {
                    id: nextId(),
                    kind: "turnComplete",
                    baselineHead: event.baselineHead,
                    baselinePaths: event.baselinePaths,
                    durationMs: event.durationMs,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheReadTokens: event.cacheReadTokens,
                    cacheWriteTokens: event.cacheWriteTokens,
                    completedAtMs: Date.now(),
                  },
                ],
                turnStartedAtMs: null,
                lastResult: {
                  sessionId: event.sessionId,
                  totalCostUsd: event.totalCostUsd,
                  durationMs: event.durationMs,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  cacheReadTokens: event.cacheReadTokens,
                  cacheWriteTokens: event.cacheWriteTokens,
                  contextWindow: event.contextWindow,
                },
              },
            },
          };
        case "error":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                lastEventAtMs: now,
                items: [...closed(), { id: nextId(), kind: "error", message: event.message }],
              },
            },
          };
        case "exit":
          if (tab.status === "settling") {
            return {
              byRunId: {
                ...s.byRunId,
                [runId]: {
                  ...tab,
                  status: tab.errorMessage ? "error" : "idle",
                  turnStartedAtMs: null,
                },
              },
            };
          }
          // A non-zero/unexpected exit *without* a preceding `turnResult`
          // means the process died mid-turn rather than finishing
          // normally — surface that instead of leaving the UI on a
          // spinner forever (docs/CHECKLIST.md edge case).
          if (tab.status === "working") {
            notifyIfBackgrounded(runId, "error", "Agent crashed");
            return {
              byRunId: {
                ...s.byRunId,
                [runId]: {
                  ...tab,
                  status: "error",
                  turnStartedAtMs: null,
                  errorMessage: `Agent process exited unexpectedly${event.code !== null ? ` (code ${event.code})` : ""}.`,
                },
              },
            };
          }
          return s;
        case "status": {
          if (!event.text) return s;
          // Coalesce: a retry loop emits one note per attempt, so replace
          // a trailing status item in place instead of stacking cards.
          const last = items[items.length - 1];
          if (last?.kind === "status") {
            const next = items.slice();
            next[next.length - 1] = { ...last, text: event.text };
            return {
              byRunId: {
                ...s.byRunId,
                [runId]: { ...tab, lastEventAtMs: now, items: next },
              },
            };
          }
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                lastEventAtMs: now,
                items: [...closed(), { id: nextId(), kind: "status", text: event.text }],
              },
            },
          };
        }
        case "raw":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: [...closed(), { id: nextId(), kind: "raw", json: event.json }],
              },
            },
          };
        default:
          return s;
      }
    });
  },
}));
