//! What each wrapped CLI can actually do — declared once, in one place.
//!
//! ## Why this exists
//!
//! Every chat feature (streaming, plan mode, fork-and-retry, cost and
//! context reporting, the permission gate) is implemented *generically*
//! against the flags below. Nothing in the UI or in `manager.rs` should
//! ever match on `AgentKind` to decide whether to offer a feature — it
//! asks the capability instead. That is what makes adding a provider a
//! matter of writing one `AgentCapabilities` literal here and an adapter
//! that parses its wire format, rather than re-deriving the whole chat
//! surface for each new CLI.
//!
//! ## The rule for filling one in
//!
//! A flag is `true` only when the behaviour has been confirmed against a
//! real binary — a flag set from a CLI's marketing page or from a guess at
//! a flag name is exactly the "fake dropdown" docs/V1_SCOPE.md §6 forbids,
//! and it will surface as a feature that silently does nothing. Where a
//! capability is absent, say why in `manual_gate_detail`/the comments so
//! the UI can tell the user the truth instead of pretending.

use crate::agents::registry::AgentKind;
use serde::{Deserialize, Serialize};

/// How much of the model's output a CLI will stream as it is produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Streaming {
    /// Text only arrives in finished blocks. The UI shows an activity
    /// card until the block lands.
    Blocks,
    /// Token-level deltas are available, so assistant text can be typed
    /// out as the model writes it.
    Deltas,
}

/// How a run's `Manual` permission mode is actually enforced — the thing
/// that decides whether Maestro can honestly promise "it will ask first".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManualGate {
    /// The CLI reports a blocked tool call, and Maestro pauses the turn on
    /// it and waits for the user (see `manager.rs`'s pause branch).
    /// The only mode that genuinely asks before acting.
    Prompt,
    /// No per-call approval exists, but the CLI confines the run with a
    /// real sandbox, so Manual still means something narrower than Auto.
    Sandbox,
    /// Neither. Approval policy lives in the CLI's own config, outside
    /// Maestro's control — the UI must say so rather than implying it is
    /// gating anything.
    ExternalConfig,
}

/// One provider's declared feature set. Serialized to the frontend on
/// `CliStatus` so the UI can light up affordances without knowing which
/// CLI it is talking to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub streaming: Streaming,
    pub manual_gate: ManualGate,
    /// Shown next to the Manual option when the gate isn't `Prompt`, so
    /// the mode picker explains what the mode really does for this CLI.
    /// This copy lives with the provider declaration on purpose: it is
    /// per-provider knowledge, and having it in the composer meant every
    /// new CLI needed a UI edit to stop the picker overstating itself.
    pub manual_gate_detail: Option<String>,
    /// A real read-only mode exists (not just "Manual with a nicer name").
    pub plan_mode: bool,
    /// `--resume`-style continuation of a past session.
    pub resume: bool,
    /// Resuming can branch instead of appending, which is what lets a user
    /// edit an earlier message and re-run from that point.
    pub fork_session: bool,
    /// The turn's final event carries token counts.
    pub reports_usage: bool,
    /// ...and a monetary cost.
    pub reports_cost: bool,
    /// ...and the model's context window, so usage can be shown as a
    /// fraction rather than a bare number.
    pub reports_context_window: bool,
    /// Whether effort/thinking/fast go on the command line as their own
    /// flags. When `false` the CLI encodes them in the model id itself
    /// (see `commands/agents.rs`'s `ModelVariant`), and sending them
    /// separately as well would be duplicate — or invalid — arguments.
    pub separate_option_flags: bool,
    /// What the effort control is called for this CLI, since the same
    /// dial is "thinking" to one vendor and "reasoning effort" to another.
    pub effort_label: String,
    /// The tool a CLI calls when it has finished planning and wants to
    /// start work. The transcript promotes that call out of the collapsed
    /// activity card into a proper "plan ready" step with an approve
    /// action — otherwise the whole point of Plan mode is buried three
    /// clicks deep in a list of tool calls. `None` where the CLI has no
    /// such signal, in which case Plan mode simply ends its turn with
    /// prose and there is nothing to promote.
    pub plan_exit_tool: Option<String>,
}

/// The per-provider declarations. **This is the file a new provider
/// touches.**
pub fn capabilities_for(kind: AgentKind) -> AgentCapabilities {
    match kind {
        // Verified against claude 2.1.224.
        AgentKind::ClaudeCode => AgentCapabilities {
            // `--include-partial-messages` (confirmed in `--help`).
            streaming: Streaming::Deltas,
            // Confirmed end to end: a gated tool emits `permission_denied`,
            // Maestro SIGINTs the turn there, and `--resume` with a widened
            // `--allowedTools` performs the action under the same session.
            manual_gate: ManualGate::Prompt,
            manual_gate_detail: None,
            // `--permission-mode plan`.
            plan_mode: true,
            resume: true,
            // `--fork-session`.
            fork_session: true,
            reports_usage: true,
            reports_cost: true,
            // `modelUsage.<model>.contextWindow` on the result line.
            reports_context_window: true,
            // `--effort` / `--model` are independent flags.
            separate_option_flags: true,
            effort_label: "Thinking".to_string(),
            // Confirmed in this build's `--permission-mode plan` tool list.
            plan_exit_tool: Some("ExitPlanMode".to_string()),
        },
        // Verified against cursor-agent 2026.08.11-e8db854.
        AgentKind::CursorAgent => AgentCapabilities {
            // `--stream-partial-output` (confirmed in `--help`).
            streaming: Streaming::Deltas,
            // Confirmed the hard way: with `approvalMode: "unrestricted"`
            // a `-p` run created a file with nothing asked, and
            // `--sandbox enabled` does not gate in-worktree edits either.
            // There is no per-invocation allow-list to gate with.
            manual_gate: ManualGate::ExternalConfig,
            manual_gate_detail: Some(
                "Cursor Agent has no per-command approval in non-interactive mode — it follows approvalMode in ~/.cursor/cli-config.json, not Maestro."
                    .to_string(),
            ),
            // `--mode plan`.
            plan_mode: true,
            resume: true,
            // No `--fork-session` equivalent; `--resume` only continues.
            fork_session: false,
            reports_usage: true,
            // Never reported by this CLI — showing $0.00 would read as
            // "this turn was free" rather than "unknown".
            reports_cost: false,
            reports_context_window: false,
            // Effort/thinking/fast are baked into the model id itself
            // (e.g. `claude-opus-4-8[context=1m,effort=high,fast=false]`),
            // so there is no separate flag to send.
            separate_option_flags: false,
            effort_label: "Effort".to_string(),
            // `--mode plan` ends with prose, with no confirmed tool call
            // marking the hand-off.
            plan_exit_tool: None,
        },
        // Verified against codex-cli 0.147.0, except where noted.
        AgentKind::Codex => AgentCapabilities {
            // No partial-output flag in `codex exec --help`.
            streaming: Streaming::Blocks,
            // `codex exec` cannot ask mid-run, but `--sandbox` is real.
            manual_gate: ManualGate::Sandbox,
            manual_gate_detail: Some(
                "Codex can't ask mid-run: edits are confined to this worktree by its sandbox instead."
                    .to_string(),
            ),
            // `--sandbox read-only`.
            plan_mode: true,
            // `codex exec resume <id>`.
            resume: true,
            fork_session: false,
            reports_usage: true,
            reports_cost: false,
            reports_context_window: false,
            // `-c model_reasoning_effort=...` / `-c service_tier=...`.
            separate_option_flags: true,
            effort_label: "Reasoning".to_string(),
            plan_exit_tool: None,
        },
        // Verified against aider 0.86.2, including a live turn driven
        // against a local OpenAI-compatible server.
        AgentKind::Aider => AgentCapabilities {
            // Aider emits no JSON, but with `--no-pretty --stream` it
            // writes the reply progressively rather than in one block —
            // timestamped line arrival during a live run confirmed text
            // landing in step with the model's output. The granularity is
            // per line rather than per token, which is a difference the
            // user sees as slightly chunkier typing, not as a stall.
            streaming: Streaming::Deltas,
            // Aider's confirmations are interactive stdin prompts with no
            // machine-readable form, and it has no sandbox. Maestro cannot
            // honestly claim to gate anything.
            manual_gate: ManualGate::ExternalConfig,
            manual_gate_detail: Some(
                "Aider can't ask Maestro for approval — its prompts are interactive only. Edits land in this worktree for you to review before committing."
                    .to_string(),
            ),
            // `--chat-mode ask` is a real read-only mode, not Manual under
            // another name. Confirmed from the accepted-values list.
            plan_mode: true,
            // Aider has no `--resume` and no session ids. Maestro supplies
            // both by owning the `--chat-history-file` (see `aider/mod.rs`)
            // — measured working: replaying history raised an identical
            // prompt's cost from 774 to 916 tokens.
            resume: true,
            // Branching that history is a file copy.
            fork_session: true,
            // "Tokens: 776 sent, 28 received." after every round trip.
            reports_usage: true,
            // "Cost: $X message, $Y session." — present whenever LiteLLM
            // knows the model's pricing, absent for local models, where the
            // adapter reports `None` rather than a misleading $0.00.
            reports_cost: true,
            // Never reported.
            reports_context_window: false,
            // `--model` and `--reasoning-effort` are independent flags.
            separate_option_flags: true,
            effort_label: "Reasoning".to_string(),
            // No structured signal marks the end of planning in `ask` mode;
            // it simply answers in prose.
            plan_exit_tool: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_declares_capabilities() {
        // A new `AgentKind` variant makes `capabilities_for`'s match fail
        // to compile, which is the point — a provider cannot be added
        // without declaring what it supports.
        for kind in AgentKind::all() {
            let caps = capabilities_for(kind);
            // A gate that can't prompt owes the user an explanation.
            if caps.manual_gate != ManualGate::Prompt {
                assert!(
                    caps.manual_gate_detail.is_some(),
                    "{kind:?} can't prompt for permission but doesn't say why"
                );
            }
        }
    }

    #[test]
    fn a_plan_exit_tool_implies_plan_mode() {
        for kind in AgentKind::all() {
            let caps = capabilities_for(kind);
            assert!(caps.plan_exit_tool.is_none() || caps.plan_mode, "{kind:?}");
        }
    }

    #[test]
    fn forking_requires_resume() {
        // Forking is a branch off an existing session; claiming it without
        // resume would be incoherent.
        for kind in AgentKind::all() {
            let caps = capabilities_for(kind);
            assert!(!caps.fork_session || caps.resume, "{kind:?}");
        }
    }

    #[test]
    fn context_window_reporting_implies_usage_reporting() {
        for kind in AgentKind::all() {
            let caps = capabilities_for(kind);
            assert!(
                !caps.reports_context_window || caps.reports_usage,
                "{kind:?}"
            );
        }
    }
}
