import { create } from "zustand";
import { relayClient } from "../api/client";
import { openStream } from "../api/stream";
import type { AgentEvent, PermissionDecision } from "../api/types";
import {
  applyEvent,
  emptyRunState,
  nextId,
  setToolCallPermissionStatus,
  type RunState,
  type TranscriptItem,
} from "./transcript";

export type StreamStatus = "connecting" | "open" | "closed";

interface AgentSessionState {
  byRunId: Record<string, RunState>;
  streamStatusByRunId: Record<string, StreamStatus>;
  closersByRunId: Record<string, () => void>;
  /** The last event sequence received per run. Sent back as `?since=` on
   * every reconnect, which is what makes a WiFi/cellular handoff resume
   * exactly where it stopped instead of silently dropping whatever
   * streamed while the socket was down. */
  lastSeqByRunId: Record<string, number>;

  /** Idempotent — subscribes to the run's live event stream and, once
   * connected, best-effort hydrates its saved transcript. Safe to call
   * from a screen's mount effect on every render, same contract as the
   * desktop's `agentSessionStore.ts::openRun`. */
  open: (runId: string) => void;
  close: (runId: string) => void;

  sendMessage: (runId: string, text: string) => Promise<void>;
  respondPermission: (
    runId: string,
    toolCallId: string,
    decision: PermissionDecision,
  ) => Promise<void>;
  interrupt: (runId: string) => Promise<void>;
  kill: (runId: string) => Promise<void>;
}

/** Mirrors the desktop's `hydrateRun` guard: a live event arriving before
 * the disk read resolves means the run is actively streaming, and the
 * stale-by-up-to-1.5s persisted snapshot must not clobber it — better to
 * start from whatever the live stream builds up than to show a
 * frozen-then-jumping transcript. */
async function hydrate(
  runId: string,
  get: () => AgentSessionState,
  set: (fn: (s: AgentSessionState) => Partial<AgentSessionState>) => void,
) {
  let stored;
  try {
    stored = await relayClient.getAgentTranscript(runId);
  } catch {
    return;
  }
  if (!stored) return;
  if ((get().byRunId[runId]?.items.length ?? 0) > 0) return;

  let items: TranscriptItem[];
  try {
    const parsed: unknown = JSON.parse(stored.items);
    if (!Array.isArray(parsed)) return;
    items = (parsed as TranscriptItem[]).map((item) => ({ ...item, id: nextId() }));
  } catch {
    return;
  }
  if (items.length === 0) return;

  set((s) => {
    const run = s.byRunId[runId] ?? emptyRunState();
    if (run.items.length > 0) return s; // Raced a live event; leave it be.
    return {
      byRunId: {
        ...s.byRunId,
        [runId]: {
          ...run,
          items,
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
}

/** One frame off the agent socket — see `relay/ws.rs::RelayFrame`. The
 * stream always opens with a `snapshot` saying where the run is and how
 * much history follows, then streams `event` frames. */
type RelayFrame =
  | {
      frame: "snapshot";
      snapshot: {
        status: "idle" | "working" | "awaitingPermission" | "error";
        seq: number;
        events: { seq: number; event: AgentEvent }[];
        /** The requested `since` is older than the server's log can
         * serve — the transcript can't be rebuilt from this backlog. */
        truncated: boolean;
        /** No in-memory log at all (the run predates this desktop
         * process), so the persisted transcript is the only history. */
        cold: boolean;
      };
    }
  | { frame: "event"; event: { seq: number; event: AgentEvent } };

/** The run status the backend folded from the run's own events, mapped
 * onto the transcript reducer's vocabulary. This is the fix for a phone
 * showing "idle" for a turn the desktop started: status is now a fact
 * reported by the run, not something a client could only know by having
 * sent the prompt itself. */
const STATUS_FROM_SNAPSHOT = {
  idle: "idle",
  working: "working",
  awaitingPermission: "awaitingPermission",
  error: "error",
} as const;

export const useAgentStore = create<AgentSessionState>((set, get) => ({
  byRunId: {},
  streamStatusByRunId: {},
  closersByRunId: {},
  lastSeqByRunId: {},

  open: (runId) => {
    if (get().closersByRunId[runId]) return;
    set((s) => ({ byRunId: { ...s.byRunId, [runId]: s.byRunId[runId] ?? emptyRunState() } }));

    const applySequenced = (sequenced: { seq: number; event: AgentEvent }) => {
      set((s) => {
        // Out-of-order or repeated frames are dropped rather than applied
        // twice — the seam between a replayed backlog and the live tail is
        // exactly where a duplicate would otherwise land.
        if (sequenced.seq !== 0 && sequenced.seq <= (s.lastSeqByRunId[runId] ?? 0)) return s;
        const run = s.byRunId[runId] ?? emptyRunState();
        return {
          byRunId: { ...s.byRunId, [runId]: applyEvent(run, sequenced.event) },
          lastSeqByRunId: {
            ...s.lastSeqByRunId,
            [runId]: Math.max(s.lastSeqByRunId[runId] ?? 0, sequenced.seq),
          },
        };
      });
    };

    const close = openStream(
      () => {
        const since = get().lastSeqByRunId[runId] ?? 0;
        return `/api/agents/${encodeURIComponent(runId)}/stream?since=${since}`;
      },
      (raw) => {
        let frame: RelayFrame;
        try {
          frame = JSON.parse(raw) as RelayFrame;
        } catch {
          return;
        }

        if (frame.frame === "event") {
          applySequenced(frame.event);
          return;
        }

        const { snapshot } = frame;
        const resuming = (get().lastSeqByRunId[runId] ?? 0) > 0;
        if (snapshot.cold || snapshot.truncated) {
          // Either the desktop restarted (no live log) or this client fell
          // too far behind to be caught up. Both are recoverable, but only
          // by starting from the persisted transcript rather than
          // rendering a hole.
          set((s) => ({
            byRunId: { ...s.byRunId, [runId]: emptyRunState() },
            lastSeqByRunId: { ...s.lastSeqByRunId, [runId]: snapshot.seq },
          }));
          void hydrate(runId, get, set);
        } else if (!resuming) {
          // A fresh attach: the backlog *is* the whole conversation, so
          // start from nothing and let it rebuild — no stale persisted
          // copy to reconcile against.
          set((s) => ({ byRunId: { ...s.byRunId, [runId]: emptyRunState() } }));
        }

        for (const sequenced of snapshot.events) applySequenced(sequenced);

        // Applied last so it wins over whatever the replayed events
        // implied: the server's fold is authoritative.
        set((s) => {
          const run = s.byRunId[runId] ?? emptyRunState();
          return {
            byRunId: {
              ...s.byRunId,
              [runId]: { ...run, status: STATUS_FROM_SNAPSHOT[snapshot.status] },
            },
          };
        });
      },
      (status) =>
        set((s) => ({ streamStatusByRunId: { ...s.streamStatusByRunId, [runId]: status } })),
    );
    set((s) => ({ closersByRunId: { ...s.closersByRunId, [runId]: close } }));
  },

  close: (runId) => {
    get().closersByRunId[runId]?.();
    set((s) => {
      const closersByRunId = { ...s.closersByRunId };
      delete closersByRunId[runId];
      return { closersByRunId };
    });
  },

  sendMessage: async (runId, text) => {
    await relayClient.sendAgentMessage(runId, text);
  },

  respondPermission: async (runId, toolCallId, decision) => {
    set((s) => {
      const run = s.byRunId[runId];
      if (!run) return s;
      const status = decision.decision === "approve" ? "approved" : "denied";
      const next = setToolCallPermissionStatus(run, toolCallId, status);
      return {
        byRunId: {
          ...s.byRunId,
          [runId]: {
            ...next,
            status: decision.decision === "approve" ? "working" : "idle",
            turnStartedAtMs: decision.decision === "approve" ? Date.now() : null,
          },
        },
      };
    });
    await relayClient.respondToPermission(runId, decision);
  },

  interrupt: async (runId) => {
    await relayClient.interruptAgent(runId);
  },
  kill: async (runId) => {
    await relayClient.killAgent(runId);
  },
}));
