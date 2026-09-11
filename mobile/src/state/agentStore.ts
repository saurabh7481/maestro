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

export const useAgentStore = create<AgentSessionState>((set, get) => ({
  byRunId: {},
  streamStatusByRunId: {},
  closersByRunId: {},

  open: (runId) => {
    if (get().closersByRunId[runId]) return;
    set((s) => ({ byRunId: { ...s.byRunId, [runId]: s.byRunId[runId] ?? emptyRunState() } }));
    const close = openStream(
      `/api/agents/${encodeURIComponent(runId)}/stream`,
      (raw) => {
        let event: AgentEvent;
        try {
          event = JSON.parse(raw) as AgentEvent;
        } catch {
          return;
        }
        set((s) => {
          const run = s.byRunId[runId] ?? emptyRunState();
          return { byRunId: { ...s.byRunId, [runId]: applyEvent(run, event) } };
        });
      },
      (status) =>
        set((s) => ({ streamStatusByRunId: { ...s.streamStatusByRunId, [runId]: status } })),
    );
    set((s) => ({ closersByRunId: { ...s.closersByRunId, [runId]: close } }));
    void hydrate(runId, get, set);
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
