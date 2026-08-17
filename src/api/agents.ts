import { invoke } from "@tauri-apps/api/core";
import type {
  AgentKind,
  AiderProviderStatus,
  CliStatus,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
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

  /** Aider's LLM providers. Unlike the other CLIs, Aider has no login of
   * its own — these are what make it usable at all. */
  listAiderProviders: () => invoke<AiderProviderStatus[]>("list_aider_providers"),
  saveAiderProvider: (providerId: string, values: Record<string, string>, enabled: boolean) =>
    invoke<void>("save_aider_provider", { request: { providerId, values, enabled } }),
  forgetAiderProvider: (providerId: string) =>
    invoke<void>("forget_aider_provider", { providerId }),
  /** `null` when secrets can be stored; otherwise why they can't. */
  aiderKeychainStatus: () => invoke<string | null>("aider_keychain_status"),

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
    permissionMode: PermissionMode;
  }) => invoke<void>("start_agent_session", { request }),
  sendAgentMessage: (runId: string, text: string) =>
    invoke<void>("send_agent_message", { runId, text }),
  respondToPermission: (runId: string, decision: PermissionDecision) =>
    invoke<PermissionOutcome>("respond_to_permission", { runId, decision }),
  setPermissionMode: (runId: string, mode: PermissionMode) =>
    invoke<void>("set_permission_mode", { runId, mode }),
  /** Branches the CLI session on the next turn, so editing an earlier
   * message leaves the original conversation intact. Only has an effect
   * where `capabilities.forkSession` is true. */
  forkAgentSession: (runId: string) => invoke<void>("fork_agent_session", { runId }),
  setAgentConfiguration: (
    runId: string,
    model: string | null,
    effort: string | null,
    fast: boolean,
  ) => invoke<void>("set_agent_configuration", { runId, model, effort, fast }),
  /** Persisted rendering of a conversation — see `agents/transcripts.rs`
   * for why the CLI's own session history isn't a substitute. */
  saveAgentTranscript: (
    runId: string,
    worktreeId: string,
    agent: AgentKind,
    cliSessionId: string | null,
    items: string,
  ) => invoke<void>("save_agent_transcript", { runId, worktreeId, agent, cliSessionId, items }),
  loadAgentTranscript: (runId: string) =>
    invoke<{ items: string; cliSessionId: string | null } | null>("load_agent_transcript", {
      runId,
    }),
  deleteAgentTranscript: (runId: string) => invoke<void>("delete_agent_transcript", { runId }),
  pruneAgentTranscripts: (keepRunIds: string[]) =>
    invoke<number>("prune_agent_transcripts", { keepRunIds }),

  interruptAgent: (runId: string) => invoke<void>("interrupt_agent", { runId }),
  killAgent: (runId: string) => invoke<void>("kill_agent", { runId }),
  killAgentRunsForWorktree: (worktreeId: string) =>
    invoke<string[]>("kill_agent_runs_for_worktree", { worktreeId }),
};
