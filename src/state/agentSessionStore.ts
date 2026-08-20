import { create } from "zustand";
import { agentsApi } from "../api/agents";
import { listenToAgentEvents } from "../api/agentEvents";
import type { AgentEvent, TranscriptTurn } from "../types/agent";
import { useTabsStore } from "./tabsStore";
import { useToastStore, isAppFocused } from "./toastStore";

/** A run's tab is "backgrounded" if it's not the active tab, or the whole
 * app window doesn't have OS focus — either way the transcript update
 * that just happened isn't something the user is currently looking at,
 * so it's worth a toast rather than relying on them to notice. */
function notifyIfBackgrounded(runId: string, tone: "success" | "error", title: string): void {
  const { tabs, activeTabId } = useTabsStore.getState();
  if (activeTabId === runId && isAppFocused()) return;
  const tab = tabs.find((t) => t.id === runId);
  useToastStore.getState().push({ tone, title, description: tab?.title });
}

/** A stable, module-scoped empty array for `attachedByRunId[id] ??
 * EMPTY_ATTACHMENTS` selectors — never `?? []`. A fresh `[]` literal as
 * a selector's fallback returns a new reference on every read, which
 * `useSyncExternalStore` (what zustand's hook is built on) treats as
 * "the subscribed value changed" on every single store notification,
 * not just ones that actually touch this run's attachments — re-render,
 * re-select, new `[]` again, forever. Same trap `workspaceStore.ts`'s
 * `EMPTY_WORKTREES` and `agentAvailabilityStore.ts`'s `useReadyAgentKinds`
 * already document; confirmed live here too (`AgentComposer.tsx`'s
 * attachment selector crashed every fresh agent tab with "Maximum update
 * depth exceeded" before this fix). */
export const EMPTY_ATTACHMENTS: string[] = [];

/** Same stable-reference requirement as `EMPTY_ATTACHMENTS` — see its
 * comment for what a `?? []` fallback does to a zustand selector. */
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
  | { id: string; kind: "raw"; json: unknown };

/** `awaitingPermission` is a real third resting state, not a flavour of
 * `working`: the CLI process is gone and the turn is over, but the run is
 * mid-thought and waiting on the user's Approve/Deny before it can pick up
 * where it stopped. Keeping it distinct is what stops the following `exit`
 * event from being reported as a crash. */
export type AgentRunStatus = "idle" | "working" | "awaitingPermission" | "error";

export interface AgentTabState {
  items: TranscriptItem[];
  status: AgentRunStatus;
  errorMessage: string | null;
  lastResult: {
    sessionId: string;
    totalCostUsd: number | null;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    /** The model's context window, for showing usage as a fraction. */
    contextWindow: number | null;
  } | null;
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
  turnBaseline: { head: string | null; paths: string[] } | null;
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
    turnBaseline: null,
    queued: [],
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

/** Debounced per run: a streaming turn touches the transcript many times a
 * second, and writing SQLite on each one would be pure waste. */
const persistTimers = new Map<string, number>();
const PERSIST_DEBOUNCE_MS = 1500;

function schedulePersist(runId: string): void {
  const existing = persistTimers.get(runId);
  if (existing !== undefined) window.clearTimeout(existing);
  persistTimers.set(
    runId,
    window.setTimeout(() => {
      persistTimers.delete(runId);
      void persistNow(runId);
    }, PERSIST_DEBOUNCE_MS),
  );
}

async function persistNow(runId: string): Promise<void> {
  const tab = useAgentSessionStore.getState().byRunId[runId];
  if (!tab || tab.items.length === 0) return;
  const info = useTabsStore.getState().tabs.find((t) => t.id === runId);
  if (!info?.agentKind) return;
  try {
    await agentsApi.saveAgentTranscript(
      runId,
      info.worktreeId ?? "",
      info.agentKind,
      tab.lastResult?.sessionId ?? null,
      JSON.stringify(forPersistence(tab.items)),
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

  /** Files staged via the composer's "Add context" attach button (as
   * opposed to an inline `@mention` typed directly into the draft) —
   * same survives-remount reasoning as `draftByRunId`. Turned into
   * `@path` mentions prepended to the message text on send (see
   * `AgentComposer.tsx::submit`), reusing the exact mechanism inline
   * mentions already use rather than inventing a second, unverified
   * attachment protocol. */
  attachedByRunId: Record<string, string[]>;
  addAttachment: (runId: string, path: string) => void;
  removeAttachment: (runId: string, path: string) => void;
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
  setTurnBaseline: (runId: string, head: string | null, paths: string[]) => void;
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

  attachedByRunId: {},
  addAttachment: (runId, path) =>
    set((s) => {
      const existing = s.attachedByRunId[runId] ?? [];
      if (existing.includes(path)) return s;
      return { attachedByRunId: { ...s.attachedByRunId, [runId]: [...existing, path] } };
    }),
  removeAttachment: (runId, path) =>
    set((s) => ({
      attachedByRunId: {
        ...s.attachedByRunId,
        [runId]: (s.attachedByRunId[runId] ?? []).filter((p) => p !== path),
      },
    })),
  clearAttachments: (runId) =>
    set((s) => ({ attachedByRunId: { ...s.attachedByRunId, [runId]: [] } })),

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

    let stored: { items: string; cliSessionId: string | null } | null = null;
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
                  totalCostUsd: null,
                  durationMs: 0,
                  inputTokens: null,
                  outputTokens: null,
                  cacheReadTokens: null,
                  cacheWriteTokens: null,
                  contextWindow: null,
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
      const attachedByRunId = { ...s.attachedByRunId };
      delete byRunId[runId];
      delete unlistenByRunId[runId];
      delete draftByRunId[runId];
      delete attachedByRunId[runId];
      return { byRunId, unlistenByRunId, draftByRunId, attachedByRunId };
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
          turnBaseline: null,
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
      // Sending a new instruction answers an outstanding permission request
      // by moving on from it. Leaving the card live would offer an Approve
      // button that resumes an action the conversation has already left
      // behind — and the tool genuinely never ran, so "denied" is the
      // accurate record of what happened to it.
      const items = tab.items.map((item) =>
        item.kind === "toolCall" && item.permission?.status === "pending"
          ? { ...item, permission: { status: "denied" } as PermissionState }
          : item,
      );
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: {
            ...tab,
            status: "working",
            errorMessage: null,
            turnStartedAtMs: Date.now(),
            lastEventAtMs: Date.now(),
            items: [...items, { id: nextId(), kind: "user", text }],
          },
        },
      };
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

  setTurnBaseline: (runId, head, paths) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return {
        byRunId: { ...s.byRunId, [runId]: { ...tab, turnBaseline: { head, paths } } },
      };
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
                status: event.isError ? "error" : "idle",
                errorMessage: event.isError
                  ? (event.resultText ?? "The agent reported that this turn failed.")
                  : null,
                items: [
                  ...closed(),
                  {
                    id: nextId(),
                    kind: "turnComplete",
                    baselineHead: tab.turnBaseline?.head ?? null,
                    baselinePaths: tab.turnBaseline?.paths ?? [],
                    durationMs: event.durationMs,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheReadTokens: event.cacheReadTokens,
                    cacheWriteTokens: event.cacheWriteTokens,
                    completedAtMs: Date.now(),
                  },
                ],
                turnBaseline: null,
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
