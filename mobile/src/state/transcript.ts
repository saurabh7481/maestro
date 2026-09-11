import type { AgentEvent, LastResultPayload } from "../api/types";

/** Ported from the desktop's `src/state/agentSessionStore.ts` — same
 * `TranscriptItem` shape and the same `applyEvent` reducer logic, trimmed
 * of desktop-only concerns (OS/toast notifications, debounced SQLite
 * persistence — the desktop stays the sole writer of a session's stored
 * transcript; mobile only reads it on cold-open). Keeping the shape
 * identical matters: a session's stored transcript (`GET
 * /api/agents/{runId}/transcript`) is literally JSON produced by that
 * same reducer, and it must render the same way on both surfaces. */

export type PermissionState =
  | { status: "pending"; message: string }
  | { status: "blocked"; message: string }
  | { status: "approved" }
  | { status: "denied" };

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistantText"; text: string; streaming?: boolean }
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
      completedAtMs: number | null;
    }
  | { id: string; kind: "raw"; json: unknown }
  | { id: string; kind: "status"; text: string };

export type AgentRunStatus = "idle" | "working" | "settling" | "awaitingPermission" | "error";

export interface RunState {
  items: TranscriptItem[];
  status: AgentRunStatus;
  errorMessage: string | null;
  lastResult: ({ sessionId: string } & LastResultPayload) | null;
  turnStartedAtMs: number | null;
  lastEventAtMs: number | null;
}

export function emptyRunState(): RunState {
  return {
    items: [],
    status: "idle",
    errorMessage: null,
    lastResult: null,
    turnStartedAtMs: null,
    lastEventAtMs: null,
  };
}

let itemSeq = 0;
export function nextId(): string {
  itemSeq += 1;
  return `item-${itemSeq}`;
}

function openStreamIndex(items: TranscriptItem[]): number {
  const last = items.length - 1;
  return last >= 0 && items[last].kind === "assistantText" && items[last].streaming ? last : -1;
}

function lastAssistantTextIndex(items: TranscriptItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const kind = items[i].kind;
    if (kind === "assistantText") return i;
    if (kind === "turnComplete" || kind === "user") return -1;
  }
  return -1;
}

function closeStream(items: TranscriptItem[]): TranscriptItem[] {
  const index = openStreamIndex(items);
  if (index === -1) return items;
  const next = items.slice();
  const item = next[index] as Extract<TranscriptItem, { kind: "assistantText" }>;
  next[index] = { ...item, streaming: false };
  return next;
}

export function applyUserMessage(run: RunState, text: string): RunState {
  const items = run.items.map((item) =>
    item.kind === "toolCall" && item.permission?.status === "pending"
      ? { ...item, permission: { status: "denied" } as PermissionState }
      : item,
  );
  return {
    ...run,
    status: "working",
    errorMessage: null,
    turnStartedAtMs: Date.now(),
    lastEventAtMs: Date.now(),
    items: [...items, { id: nextId(), kind: "user", text }],
  };
}

export function setToolCallPermissionStatus(
  run: RunState,
  toolCallId: string,
  status: "approved" | "denied",
): RunState {
  return {
    ...run,
    items: run.items.map((item) =>
      item.kind === "toolCall" && item.toolCallId === toolCallId
        ? { ...item, permission: { status } as PermissionState }
        : item,
    ),
  };
}

export function applyEvent(run: RunState, event: AgentEvent): RunState {
  if (!event?.type) return run;
  const items = run.items;
  const now = Date.now();
  const closed = () => closeStream(items);

  switch (event.type) {
    case "message": {
      if (event.role === "user") {
        if (!event.text) return run;
        return applyUserMessage(run, event.text);
      }
      if (event.role !== "assistant" || !event.text) return run;
      const streamIndex = openStreamIndex(items);
      if (streamIndex !== -1) {
        const next = items.slice();
        next[streamIndex] = {
          ...(next[streamIndex] as Extract<TranscriptItem, { kind: "assistantText" }>),
          text: event.text,
          streaming: false,
        };
        return { ...run, items: next };
      }
      const priorIndex = lastAssistantTextIndex(items);
      const prior =
        priorIndex !== -1
          ? (items[priorIndex] as Extract<TranscriptItem, { kind: "assistantText" }>)
          : null;
      if (prior && event.text.startsWith(prior.text)) {
        const next = items.slice();
        next[priorIndex] = { ...prior, text: event.text, streaming: false };
        return { ...run, items: next };
      }
      return {
        ...run,
        items: [...items, { id: nextId(), kind: "assistantText", text: event.text }],
      };
    }
    case "messageDelta": {
      if (!event.text) return run;
      const streamIndex = openStreamIndex(items);
      if (streamIndex !== -1) {
        const next = items.slice();
        const open = next[streamIndex] as Extract<TranscriptItem, { kind: "assistantText" }>;
        next[streamIndex] = { ...open, text: open.text + event.text };
        return { ...run, items: next };
      }
      return {
        ...run,
        items: [
          ...items,
          { id: nextId(), kind: "assistantText", text: event.text, streaming: true },
        ],
      };
    }
    case "thinking": {
      const since = run.lastEventAtMs ?? run.turnStartedAtMs;
      return {
        ...run,
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
      };
    }
    case "toolCall":
      return {
        ...run,
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
      };
    case "toolResult":
      return {
        ...run,
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
      };
    case "permissionDenied":
      return {
        ...run,
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
      };
    case "awaitingPermission":
      return { ...run, status: "awaitingPermission", errorMessage: null, turnStartedAtMs: null };
    case "turnResult":
      return {
        ...run,
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
      };
    case "error":
      return {
        ...run,
        lastEventAtMs: now,
        items: [...closed(), { id: nextId(), kind: "error", message: event.message }],
      };
    case "exit":
      if (run.status === "settling") {
        return { ...run, status: run.errorMessage ? "error" : "idle", turnStartedAtMs: null };
      }
      if (run.status === "working") {
        return {
          ...run,
          status: "error",
          turnStartedAtMs: null,
          errorMessage: `Agent process exited unexpectedly${event.code !== null ? ` (code ${event.code})` : ""}.`,
        };
      }
      return run;
    case "status": {
      if (!event.text) return run;
      const last = items[items.length - 1];
      if (last?.kind === "status") {
        const next = items.slice();
        next[next.length - 1] = { ...last, text: event.text };
        return { ...run, lastEventAtMs: now, items: next };
      }
      return {
        ...run,
        lastEventAtMs: now,
        items: [...closed(), { id: nextId(), kind: "status", text: event.text }],
      };
    }
    case "raw":
      return { ...run, items: [...closed(), { id: nextId(), kind: "raw", json: event.json }] };
    default:
      return run;
  }
}
