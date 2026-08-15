import { create } from "zustand";
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

export type PermissionState =
  { status: "pending"; message: string } | { status: "approved" } | { status: "denied" };

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistantText"; text: string }
  | { id: string; kind: "thinking"; text: string }
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
  | { id: string; kind: "turnComplete"; baselineHead: string | null; baselinePaths: string[] }
  /** An event Maestro's adapter for this CLI didn't recognize and
   * forwarded verbatim rather than dropping (docs/CHECKLIST.md's "no
   * silent failure") — rendered as a small collapsed raw-JSON card
   * rather than being invisible. Expected to show up mainly for
   * `codex.rs`, whose event shapes are best-effort/unverified. */
  | { id: string; kind: "raw"; json: unknown };

export type AgentRunStatus = "idle" | "working" | "error";

export interface AgentTabState {
  items: TranscriptItem[];
  status: AgentRunStatus;
  errorMessage: string | null;
  lastResult: { sessionId: string; totalCostUsd: number | null; durationMs: number } | null;
  /** Whether `start_agent_session` has been called yet — determines
   * whether the next composer submit calls `startAgentSession` or
   * `sendAgentMessage`. */
  started: boolean;
  turnBaseline: { head: string | null; paths: string[] } | null;
}

function emptyTabState(): AgentTabState {
  return {
    items: [],
    status: "idle",
    errorMessage: null,
    lastResult: null,
    started: false,
    turnBaseline: null,
  };
}

let itemSeq = 0;
function nextId(): string {
  itemSeq += 1;
  return `item-${itemSeq}`;
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
  closeRun: (runId: string) => void;
  markStarted: (runId: string) => void;
  /** Replaces a tab's transcript with a resumed session's history (see
   * `AgentTab.tsx`'s settings-panel "Resume session" list) — a fresh
   * `AgentTabState`, not a merge, since resuming genuinely swaps which
   * conversation this tab is looking at. */
  resumeSession: (runId: string, sessionId: string, turns: TranscriptTurn[]) => void;
  appendUserMessage: (runId: string, text: string) => void;
  setWorking: (runId: string) => void;
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

  closeRun: (runId) => {
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
          lastResult: { sessionId, totalCostUsd: null, durationMs: 0 },
          started: true,
          turnBaseline: null,
        },
      },
    }));
  },

  appendUserMessage: (runId, text) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: {
            ...tab,
            status: "working",
            errorMessage: null,
            items: [...tab.items, { id: nextId(), kind: "user", text }],
          },
        },
      };
    });
  },

  setWorking: (runId) => {
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      return { byRunId: { ...s.byRunId, [runId]: { ...tab, status: "working" } } };
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
    set((s) => {
      const tab = s.byRunId[runId] ?? emptyTabState();
      const items = tab.items;

      switch (event.type) {
        case "message":
          if (event.role !== "assistant" || !event.text) return s;
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: [...items, { id: nextId(), kind: "assistantText", text: event.text }],
              },
            },
          };
        case "thinking":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: [...items, { id: nextId(), kind: "thinking", text: event.text }],
              },
            },
          };
        case "toolCall":
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                items: [
                  ...items,
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
                    ? { ...item, permission: { status: "pending", message: event.message } }
                    : item,
                ),
              },
            },
          };
        case "turnResult":
          notifyIfBackgrounded(runId, "success", "Agent finished");
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: {
                ...tab,
                status: "idle",
                items: [
                  ...items,
                  {
                    id: nextId(),
                    kind: "turnComplete",
                    baselineHead: tab.turnBaseline?.head ?? null,
                    baselinePaths: tab.turnBaseline?.paths ?? [],
                  },
                ],
                turnBaseline: null,
                lastResult: {
                  sessionId: event.sessionId,
                  totalCostUsd: event.totalCostUsd,
                  durationMs: event.durationMs,
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
                items: [...items, { id: nextId(), kind: "error", message: event.message }],
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
                items: [...items, { id: nextId(), kind: "raw", json: event.json }],
              },
            },
          };
        default:
          return s;
      }
    });
  },
}));
