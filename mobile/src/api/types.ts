/** Wire types for the mobile relay's REST/WS API
 * (`src-tauri/src/relay/*.rs`). Mirrors — deliberately duplicated rather
 * than imported across the package boundary, since `mobile/` is a
 * standalone Vite project with its own `tsconfig.json` — the desktop's own
 * `src/types/agent.ts` and the relay's Rust structs 1:1. Keep in step with
 * both if either changes shape. */

export type AgentKind = "claudeCode" | "codex" | "cursorAgent" | "aider" | "openCode";

export const AGENT_KINDS: AgentKind[] = ["claudeCode", "codex", "cursorAgent", "aider", "openCode"];

export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = {
  claudeCode: "Claude Code",
  codex: "Codex CLI",
  cursorAgent: "Cursor Agent",
  aider: "Aider",
  openCode: "OpenCode",
};

export type PermissionMode = "manual" | "auto" | "plan";

/** Mirrors `models.rs`'s `Project`. */
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  addedAt: string;
}

/** Mirrors `models.rs`'s `Worktree`. */
export interface Worktree {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  isPrimary: boolean;
  isDetached: boolean;
  isLocked: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: number;
}

export type ManagedProcessKind = "agent" | "terminal" | "languageServer" | "hook";
export type ManagedProcessStatus = "running" | "idle" | "exited";

/** Mirrors `processes.rs`'s `ManagedProcess`. */
export interface ManagedProcess {
  id: string;
  kind: ManagedProcessKind;
  label: string;
  detail: string | null;
  worktreeId: string | null;
  worktreeRoot: string | null;
  tabId: string | null;
  pid: number | null;
  startedAtMs: number;
  status: ManagedProcessStatus;
  cpuPercent: number;
  memoryBytes: number;
  childProcessCount: number;
  killable: boolean;
  /** Which CLI an agent process is — `null` for every other kind. Lets the
   * sessions list open an existing agent as a tab that already knows which
   * model/effort/permission-mode picker to show, without mobile having
   * created that session itself. */
  agentKind: AgentKind | null;
}

export type AgentEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Mirrors `commands/agents.rs`'s `ModelVariant`. */
export interface ModelVariant {
  id: string;
  effort: AgentEffort | null;
  thinking: boolean;
  fast: boolean;
}

/** Mirrors `commands/agents.rs`'s `ModelOption`. */
export interface ModelOption {
  id: string;
  label: string;
  supportedEfforts: AgentEffort[];
  supportsThinking: boolean;
  supportsFast: boolean;
  variants: ModelVariant[];
}

export type ManualGate = "prompt" | "sandbox" | "externalConfig";

/** Mirrors `agents/capabilities.rs`'s `AgentCapabilities` — trimmed to the
 * fields the mobile composer's picker row actually gates on. */
export interface AgentCapabilities {
  manualGate: ManualGate;
  planMode: boolean;
  /** When false, effort/fast are encoded in the model id itself (see
   * `ModelVariant`) and must not also be sent as separate fields. */
  separateOptionFlags: boolean;
  effortLabel: string;
}

/** Mirrors `agents/manager.rs`'s `AgentConfiguration` — a run's actual
 * current model/effort/fast/permission-mode, wherever it was last set. */
export interface AgentConfiguration {
  model: string | null;
  effort: string | null;
  fast: boolean;
  permissionMode: PermissionMode;
}

/** Mirrors `agents/events.rs`'s `AgentEvent` — streamed on
 * `/api/agents/{runId}/stream`. */
export type AgentEvent =
  | { type: "message"; role: string; text: string }
  | { type: "messageDelta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "status"; text: string }
  | { type: "toolCall"; id: string; name: string; input: unknown }
  | {
      type: "toolResult";
      toolUseId: string;
      content: string;
      isError: boolean;
      diffAdded: number | null;
      diffRemoved: number | null;
    }
  | {
      type: "permissionDenied";
      toolName: string;
      toolUseId: string;
      toolInput: unknown;
      message: string;
      gated: boolean;
    }
  | { type: "awaitingPermission"; toolUseId: string }
  | {
      type: "turnResult";
      sessionId: string;
      isError: boolean;
      totalCostUsd: number | null;
      durationMs: number;
      numTurns: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      contextWindow: number | null;
      resultText: string | null;
      baselineHead: string | null;
      baselinePaths: string[];
    }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null }
  | { type: "raw"; json: unknown };

/** Mirrors `agents/manager.rs`'s `PermissionDecision`. */
export type PermissionDecision = { decision: "approve"; toolName: string } | { decision: "deny" };

/** Mirrors `agents/manager.rs`'s `PermissionOutcome`. */
export interface PermissionOutcome {
  escalatedToAuto: boolean;
  resumed: boolean;
}

export interface LastResultPayload {
  totalCostUsd: number | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  contextWindow: number | null;
}

/** Mirrors `agents/transcripts.rs`'s `StoredTranscript` — `items` is a
 * JSON-encoded `TranscriptItem[]` (see `state/transcript.ts`), opaque to
 * the server. */
export interface StoredTranscript {
  items: string;
  cliSessionId: string | null;
  lastResult: LastResultPayload | null;
}

export interface RelayDevice {
  id: string;
  name: string;
  accessLevel: "write" | "read";
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
}

export interface WhoAmI {
  deviceId: string;
  accessLevel: "write" | "read";
}
