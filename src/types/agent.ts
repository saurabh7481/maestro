/** Mirrors `src-tauri/src/agents/registry.rs`'s `AgentKind` 1:1 (its
 * `#[serde(rename_all = "camelCase")]` renames the fieldless variants to
 * these exact strings). */
export type AgentKind = "claudeCode" | "codex" | "cursorAgent";

export const AGENT_KINDS: AgentKind[] = ["claudeCode", "codex", "cursorAgent"];

export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = {
  claudeCode: "Claude Code",
  codex: "Codex CLI",
  cursorAgent: "Cursor Agent",
};

/** Mirrors `registry.rs`'s `AuthState`. `unknown` means installed but
 * auth couldn't be positively confirmed or denied (currently only
 * possible for Codex — see `registry.rs`'s doc comment) — never treat it
 * as "probably fine". */
export type AuthState = "unknown" | "authenticated" | "notAuthenticated" | "error";

/** Mirrors `registry.rs`'s `CliStatus`. */
export interface CliStatus {
  kind: AgentKind;
  installed: boolean;
  version: string | null;
  binaryPath: string;
  authState: AuthState;
  /** Wherever possible this is the CLI's own output, not Maestro copy. */
  authDetail: string | null;
  checkedAt: string;
}

/** A CLI is only actually usable — for a new agent tab or a one-shot
 * feature like commit-message generation — when both of these hold.
 * Centralized here so every consumer (`NewTabMenu`, `AgentsPane`,
 * `CommitBox`) agrees on what "ready" means. */
export function isReady(status: CliStatus | undefined): boolean {
  return !!status && status.installed && status.authState === "authenticated";
}

/** Mirrors `agents/events.rs`'s `AgentEvent` 1:1. */
export type AgentEvent =
  | { type: "message"; role: string; text: string }
  | { type: "thinking"; text: string }
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
    }
  | {
      type: "turnResult";
      sessionId: string;
      isError: boolean;
      totalCostUsd: number | null;
      durationMs: number;
      numTurns: number;
      resultText: string | null;
    }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null }
  | { type: "raw"; json: unknown };

/** Mirrors `agents/manager.rs`'s `PermissionDecision`. */
export type PermissionDecision = { decision: "approve"; toolName: string } | { decision: "deny" };

/** Mirrors `agents/adapter.rs`'s `PermissionMode`. `manual` (ask/allow-
 * list gated) is the default; `auto` bypasses gating entirely; `plan`
 * restricts the turn to read-only planning where the CLI supports it. */
export type PermissionMode = "manual" | "auto" | "plan";

/** Mirrors `commands/agents.rs`'s `ModelOption`. */
export interface ModelOption {
  id: string;
  label: string;
}

/** Mirrors `agents/slash_commands.rs`'s `SlashCommandOption`. */
export interface SlashCommandOption {
  slug: string;
  description: string;
  source: "skill" | "command" | "builtin";
}

/** Mirrors `agents/sessions.rs`'s `ResumableSession`. */
export interface ResumableSession {
  sessionId: string;
  title: string;
  lastActiveAt: string;
  turnCount: number;
  worktreeRoot: string;
}

/** Mirrors `agents/sessions.rs`'s `TranscriptTurn` — a simplified,
 * text-only replay of a past session's user/assistant turns, used to
 * hydrate a tab's transcript on resume. See that struct's doc comment
 * for why tool calls/thinking blocks aren't part of this. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}
