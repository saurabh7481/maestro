/** Mirrors `src-tauri/src/agents/registry.rs`'s `AgentKind` 1:1 (its
 * `#[serde(rename_all = "camelCase")]` renames the fieldless variants to
 * these exact strings). */
export type AgentKind = "claudeCode" | "codex" | "cursorAgent" | "aider" | "openCode";

export const AGENT_KINDS: AgentKind[] = ["claudeCode", "codex", "cursorAgent", "aider", "openCode"];

export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = {
  claudeCode: "Claude Code",
  codex: "Codex CLI",
  cursorAgent: "Cursor Agent",
  aider: "Aider",
  openCode: "OpenCode",
};

/** The kinds whose *turn path* is wired end to end — what may appear in
 * the new-tab menu and the commit-message picker. Detection/settings
 * cover all of `AGENT_KINDS`; a kind joins this list only when sending it
 * a message actually works. */
export const TAB_READY_AGENT_KINDS: AgentKind[] = [
  "claudeCode",
  "codex",
  "cursorAgent",
  "aider",
  "openCode",
];

/** Mirrors `registry.rs`'s `AuthState`. `unknown` means installed but
 * auth couldn't be positively confirmed or denied (currently only
 * possible for Codex — see `registry.rs`'s doc comment) — never treat it
 * as "probably fine". */
export type AuthState = "unknown" | "authenticated" | "notAuthenticated" | "error";

/** Mirrors `capabilities.rs`'s `Streaming`. */
export type Streaming = "blocks" | "deltas";

/** Mirrors `capabilities.rs`'s `ManualGate`. `prompt` is the only value
 * that means the agent genuinely stops and asks before acting. */
export type ManualGate = "prompt" | "sandbox" | "externalConfig";

/** Mirrors `capabilities.rs`'s `AgentCapabilities`.
 *
 * The chat UI gates every optional affordance on these flags rather than
 * on `AgentKind`, so adding a provider is a matter of declaring its
 * capabilities in `capabilities.rs` — no component needs to learn its
 * name. If you find yourself writing `kind === "claudeCode"` in a
 * component, the thing you actually want is a capability. */
export interface AgentCapabilities {
  streaming: Streaming;
  manualGate: ManualGate;
  /** Why Manual can't fully mean "ask first" for this CLI, when it can't. */
  manualGateDetail: string | null;
  planMode: boolean;
  resume: boolean;
  forkSession: boolean;
  reportsUsage: boolean;
  reportsCost: boolean;
  reportsContextWindow: boolean;
  /** When false, effort/thinking/fast are encoded in the model id itself
   * and must not also be sent as separate arguments. */
  separateOptionFlags: boolean;
  effortLabel: string;
  /** Tool name that signals "the plan is ready" for this CLI, promoted out
   * of the activity card into an approvable step. `null` where the CLI has
   * no such signal. */
  planExitTool: string | null;
}

/** Mirrors `registry.rs`'s `AuthRemedy` — the one action that fixes a
 * not-signed-in CLI, declared by the backend so the settings pane can
 * render a working button without knowing which CLI it is looking at.
 *
 * There is deliberately no "open a URL" variant for the CLIs: none of them
 * can be signed in by visiting a page, so such a button would look like it
 * worked and change nothing. */
export type AuthRemedy =
  /** Run this in a terminal; the CLI opens its own browser flow. */
  | { kind: "runCommand"; command: string; label: string }
  /** Nothing to log into — needs an LLM provider configured (Aider). */
  | { kind: "configureProvider"; label: string };

/** Mirrors `registry.rs`'s `CliStatus`. */
export interface CliStatus {
  kind: AgentKind;
  installed: boolean;
  version: string | null;
  binaryPath: string;
  authState: AuthState;
  /** Wherever possible this is the CLI's own output, not Maestro copy. */
  authDetail: string | null;
  /** What to do about a not-signed-in state. `null` once authenticated. */
  authRemedy: AuthRemedy | null;
  /** Pill wording from the backend, where the generic "Needs login" would
   * be wrong — Aider has no login, so it says "Needs provider". */
  authLabel: string | null;
  checkedAt: string;
  capabilities: AgentCapabilities;
}

/** What the chat UI falls back to before detection has resolved: the
 * least-capable provider it could be. Optional affordances stay hidden
 * until a real capability set says otherwise, so nothing flickers into
 * view and then turns out not to work. */
export const CONSERVATIVE_CAPABILITIES: AgentCapabilities = {
  streaming: "blocks",
  manualGate: "externalConfig",
  manualGateDetail: null,
  planMode: false,
  resume: false,
  forkSession: false,
  reportsUsage: false,
  reportsCost: false,
  reportsContextWindow: false,
  separateOptionFlags: true,
  effortLabel: "Effort",
  planExitTool: null,
};

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
  /** A fragment of assistant text mid-production. Providers whose
   * `capabilities.streaming` is `deltas` send these; the store appends
   * them into the open streaming item. */
  | { type: "messageDelta"; text: string }
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
      /** Whether the turn is actually stopping to wait for an answer. Only
       * `manual` mode gates; otherwise the CLI refused on its own and kept
       * working, so the transcript reports the refusal instead of offering
       * an Approve/Deny nothing is waiting on. Set by `manager.rs`. */
      gated: boolean;
    }
  /** The turn was deliberately stopped so the user can answer a permission
   * request — see `agents/manager.rs`'s pause branch. Distinguishes a
   * paused turn from the mid-turn crash the following `exit` would
   * otherwise look like. */
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
    }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null }
  | { type: "raw"; json: unknown };

/** Mirrors `agents/manager.rs`'s `PermissionDecision`. */
export type PermissionDecision = { decision: "approve"; toolName: string } | { decision: "deny" };

/** Mirrors `agents/manager.rs`'s `PermissionOutcome` — what the approval
 * actually cost, so the UI can say it out loud. */
export interface PermissionOutcome {
  /** Cursor/Codex have no per-invocation allow-list, so letting one
   * blocked action through stops gating the whole run. */
  escalatedToAuto: boolean;
  /** `false` for a denial: the turn was already stopped, so nothing ran. */
  resumed: boolean;
}

/** Mirrors `agents/adapter.rs`'s `PermissionMode`. `manual` (ask/allow-
 * list gated) is the default; `auto` bypasses gating entirely; `plan`
 * restricts the turn to read-only planning where the CLI supports it. */
export type PermissionMode = "manual" | "auto" | "plan";

/** Mirrors `commands/agents.rs`'s `ModelOption`. */
export interface ModelOption {
  id: string;
  label: string;
  supportedEfforts: AgentEffort[];
  supportsThinking: boolean;
  supportsFast: boolean;
  variants: ModelVariant[];
}

export type AgentEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ModelVariant {
  id: string;
  effort: AgentEffort | null;
  thinking: boolean;
  fast: boolean;
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

/** Mirrors `agents/aider/providers.rs`'s `FieldKind`. `secret` values live
 * in the OS keychain and are never sent back to the UI — only whether one
 * is stored (`hasSecret`). */
export type ProviderFieldKind = "secret" | "plain";

/** Mirrors `agents/aider/providers.rs`'s `Catalog`. Determines how (and
 * whether) the model picker can enumerate this provider's models. */
export type ProviderCatalog =
  | { kind: "publicHttp"; url: string }
  | { kind: "localHttp"; baseField: string; path: string; shape: string }
  | { kind: "litellmDb" }
  /** No enumerable list — the user types the model id, guided by `hint`. */
  | { kind: "manual"; hint: string };

/** Mirrors `commands/aider.rs`'s `ProviderFieldStatus`. */
export interface ProviderField {
  envVar: string;
  label: string;
  kind: ProviderFieldKind;
  required: boolean;
  placeholder: string | null;
  /** Present only for `plain` fields. Secrets are never returned. */
  value: string | null;
  /** Whether a secret is stored. Always false for `plain` fields. */
  hasSecret: boolean;
}

/** Mirrors `commands/aider.rs`'s `ProviderStatus`.
 *
 * The settings pane renders whatever a provider declares rather than
 * knowing any provider by name, so adding one in `providers.rs` needs no
 * change here. */
export interface AiderProviderStatus {
  id: string;
  displayName: string;
  modelPrefix: string;
  docsUrl: string;
  /** The provider's own key console, for the "Get API key" button. `null`
   * for local servers and custom endpoints, which have no such page. */
  consoleUrl: string | null;
  note: string | null;
  fields: ProviderField[];
  catalog: ProviderCatalog;
  enabled: boolean;
  /** Every required field has a value. */
  configured: boolean;
  /** Provider ids that can't be enabled alongside this one because they
   * share environment variables. */
  conflictsWith: string[];
}
