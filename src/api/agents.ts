import { invoke } from "@tauri-apps/api/core";
import type {
  AgentKind,
  CliStatus,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  ResumableSession,
  SlashCommandOption,
  TranscriptTurn,
} from "../types/agent";

/** Thin, typed wrapper around the agent-related Tauri command surface —
 * same pattern as `gitApi`/`workspaceApi`. */
export const agentsApi = {
  detectAgentCli: (kind: AgentKind, force = false) =>
    invoke<CliStatus>("detect_agent_cli", { kind, force }),
  detectAllAgentClis: (force = false) => invoke<CliStatus[]>("detect_all_agent_clis", { force }),
  setAgentBinaryPath: (kind: AgentKind, path: string | null) =>
    invoke<void>("set_agent_binary_path", { kind, path }),

  generateCommitMessage: (kind: AgentKind, worktreeRoot: string) =>
    invoke<string>("generate_commit_message", { kind, worktreeRoot }),
  listAgentModels: (kind: AgentKind) => invoke<ModelOption[]>("list_agent_models", { kind }),
  listSlashCommands: (kind: AgentKind, worktreeRoot: string) =>
    invoke<SlashCommandOption[]>("list_slash_commands", { kind, worktreeRoot }),

  listResumableSessions: (kind: AgentKind, worktreeRoot: string) =>
    invoke<ResumableSession[]>("list_resumable_sessions", { kind, worktreeRoot }),
  listAllResumableSessions: (kind: AgentKind) =>
    invoke<ResumableSession[]>("list_all_resumable_sessions", { kind }),
  listResumableSessionsForRoots: (kind: AgentKind, worktreeRoots: string[]) =>
    invoke<ResumableSession[]>("list_resumable_sessions_for_roots", { kind, worktreeRoots }),
  getSessionTranscript: (kind: AgentKind, worktreeRoot: string, sessionId: string) =>
    invoke<TranscriptTurn[]>("get_session_transcript", { kind, worktreeRoot, sessionId }),
  resumeAgentSession: (
    runId: string,
    worktreeId: string,
    worktreeRoot: string,
    kind: AgentKind,
    sessionId: string,
  ) => invoke<void>("resume_agent_session", { runId, worktreeId, worktreeRoot, kind, sessionId }),

  startAgentSession: (request: {
    runId: string;
    worktreeId: string;
    worktreeRoot: string;
    kind: AgentKind;
    resumeSessionId: string | null;
    forkSession: boolean;
    firstMessage: string;
    model: string | null;
    effort: string | null;
    fast: boolean;
  }) => invoke<void>("start_agent_session", { request }),
  sendAgentMessage: (runId: string, text: string) =>
    invoke<void>("send_agent_message", { runId, text }),
  respondToPermission: (runId: string, decision: PermissionDecision) =>
    invoke<void>("respond_to_permission", { runId, decision }),
  setPermissionMode: (runId: string, mode: PermissionMode) =>
    invoke<void>("set_permission_mode", { runId, mode }),
  setAgentConfiguration: (
    runId: string,
    model: string | null,
    effort: string | null,
    fast: boolean,
  ) => invoke<void>("set_agent_configuration", { runId, model, effort, fast }),
  interruptAgent: (runId: string) => invoke<void>("interrupt_agent", { runId }),
  killAgent: (runId: string) => invoke<void>("kill_agent", { runId }),
  killAgentRunsForWorktree: (worktreeId: string) =>
    invoke<string[]>("kill_agent_runs_for_worktree", { worktreeId }),
};
