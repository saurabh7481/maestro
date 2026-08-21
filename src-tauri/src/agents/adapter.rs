//! Per-CLI dispatch (docs/ROADMAP.md Phase 6 — generalizing Phase 5's
//! proven Claude Code adapter to Cursor Agent and Codex). This is the
//! *only* place that matches on `AgentKind` for turn spawning/parsing —
//! `manager.rs`'s `run_turn` calls through here and stays CLI-agnostic,
//! per docs/ARCHITECTURE.md §3.4's normalization principle.
//!
//! A deliberate non-choice: no `AgentAdapter` trait/dyn-dispatch. With
//! exactly three known CLIs (not an open-ended plugin system), a `match`
//! here is simpler than a trait object hierarchy for the same behavior —
//! see the top-level `CLAUDE.md`/repo conventions on preferring direct
//! code over premature abstraction.

use crate::agents::events::AgentEvent;
use crate::agents::registry::AgentKind;
use crate::agents::{aider, claude, codex, cursor_agent};
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;
/// Correlates a tool call's later result/denial back to the call that
/// requested it (name + original input) — needed because at least one
/// CLI (Claude) reports a denial without re-including the input. Shared
/// across adapters for signature uniformity even where a given adapter's
/// wire format makes it unnecessary.
pub type ToolUseCache = HashMap<String, (String, Value)>;

/// Cross-CLI permission posture for a turn — a real selector wired to
/// each adapter's own confirmed flag(s) below, not a decorative one
/// (docs/V1_SCOPE.md §6 "no fake dropdowns"). `Manual` (ask/allow-list
/// gated) is the default; `Auto` bypasses gating entirely (was a plain
/// `bypass_permissions: bool` before `Plan` needed a third state);
/// `Plan` restricts the turn to read-only planning where the adapter has
/// a confirmed equivalent (Claude's `--permission-mode plan`, Cursor's
/// `--mode plan`) and otherwise behaves like `Manual` rather than
/// guessing at an unconfirmed flag (Codex — see its module doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Manual,
    #[default]
    Auto,
    Plan,
}

pub struct TurnCtx<'a> {
    pub binary_path: &'a str,
    pub worktree_root: &'a str,
    pub resume_session_id: Option<&'a str>,
    pub fork_session: bool,
    /// Claude-specific (`--allowedTools`) — ignored by adapters that
    /// don't have an equivalent per-invocation allow-list.
    pub allowed_tools: &'a [String],
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub fast: bool,
    pub permission_mode: PermissionMode,
    /// Whether to ask this CLI for token-level output. Driven by
    /// `capabilities.rs` rather than decided per adapter, so a provider
    /// that gains streaming later only has to flip its declaration.
    /// Adapters whose declared `Streaming` is `Blocks` ignore it.
    pub stream_deltas: bool,
    /// Extra environment for the child. Only Aider uses this: it has no
    /// auth of its own, so the selected model's provider credentials are
    /// injected here. Passing them as environment rather than on the
    /// command line is deliberate — argv is world-readable via
    /// `/proc/<pid>/cmdline` on Linux, so `--api-key` would leak every
    /// key to any process on the machine.
    pub extra_env: &'a [(String, String)],
    /// Where Maestro keeps agent-owned session state. Only Aider uses
    /// this, to hold the chat-history file that stands in for the session
    /// id it doesn't have (see `aider/mod.rs`).
    pub session_dir: &'a std::path::Path,
    /// OpenCode only: attach this run to Maestro's managed sidecar
    /// instead of letting it cold-boot its own internal server per turn
    /// (`run --attach`, docs/OPENCODE_INTEGRATION.md §1.2). `None` falls
    /// back to self-boot — slower, but works even when the sidecar
    /// couldn't start.
    pub attach: Option<&'a crate::agents::opencode::client::Endpoint>,
}

pub struct TurnSpawn {
    pub command: Command,
    /// `Some` when the prompt must be written to the child's stdin (and
    /// stdin then closed) after spawn — only Claude's `--input-format
    /// stream-json` needs this; Cursor and Codex take the prompt as a
    /// plain argv argument.
    pub stdin_payload: Option<String>,
    /// A session id the *adapter* minted for this turn, for CLIs that have
    /// no session concept of their own. `manager.rs` records it exactly as
    /// it records an id learned from a CLI's own output, which is what
    /// lets Aider support resume and fork without the CLI knowing what a
    /// session is. `None` for every CLI that names its own sessions.
    pub assigned_session_id: Option<String>,
}

/// Whether a CLI's stdout is a stream of JSON objects (one per line) or
/// plain prose.
///
/// `manager.rs` buffers and re-joins consecutive lines when they don't
/// parse as JSON, to survive a `cursor-agent` bug that splits one object
/// across two physical lines. Applying that to a prose CLI would batch
/// four lines of the model's reply together and glue them with a literal
/// `\n`, so the reader asks here first.
pub fn uses_json_lines(kind: AgentKind) -> bool {
    match kind {
        AgentKind::ClaudeCode | AgentKind::CursorAgent | AgentKind::Codex | AgentKind::OpenCode => {
            true
        }
        // Aider has no structured output mode at all.
        AgentKind::Aider => false,
    }
}

/// Turns one line of a CLI's stderr into events.
///
/// For the three JSON CLIs, stderr really is the error channel and every
/// line is worth surfacing. Aider is different: it writes routine chatter
/// there — a "not a terminal" notice on every non-interactive run, and a
/// tqdm progress bar for its repo scan — so forwarding it verbatim filled
/// the transcript with a wall of red text that wasn't an error at all.
pub fn parse_stderr_line(kind: AgentKind, line: &str, cache: &mut ToolUseCache) -> Vec<AgentEvent> {
    match kind {
        AgentKind::ClaudeCode | AgentKind::CursorAgent | AgentKind::Codex | AgentKind::OpenCode => {
            vec![AgentEvent::Error {
                message: line.to_string(),
            }]
        }
        AgentKind::Aider => aider::parse_stderr_line(line, cache),
    }
}

/// Events an adapter can only produce once the stream has ended.
///
/// Aider prints no end-of-turn record — the other three CLIs each close a
/// turn with a final JSON line carrying usage and cost, and Aider instead
/// prints a `Tokens:`/`Cost:` line after every LLM round trip. Its adapter
/// accumulates those and emits one `TurnResult` here.
///
/// `interrupted` distinguishes a turn the user stopped from one that
/// failed on its own — without it, a deliberate stop was reported as
/// "Aider ended without a reply from the model", which blamed the
/// provider for something the user did.
pub fn finish(
    kind: AgentKind,
    cache: &ToolUseCache,
    session_id: Option<&str>,
    duration_ms: u64,
    interrupted: bool,
) -> Vec<AgentEvent> {
    match kind {
        AgentKind::ClaudeCode | AgentKind::CursorAgent | AgentKind::Codex => Vec::new(),
        AgentKind::Aider => aider::finish(
            cache,
            session_id.unwrap_or_default(),
            duration_ms,
            interrupted,
        ),
        // opencode has no final result line — its TurnResult is
        // synthesized from accumulated step_finish totals.
        AgentKind::OpenCode => crate::agents::opencode::finish(
            cache,
            session_id.unwrap_or_default(),
            duration_ms,
            interrupted,
        ),
    }
}

pub fn build_turn(kind: AgentKind, ctx: &TurnCtx, text: &str) -> TurnSpawn {
    match kind {
        AgentKind::ClaudeCode => claude::build_turn(ctx, text),
        AgentKind::CursorAgent => cursor_agent::build_turn(ctx, text),
        AgentKind::Codex => codex::build_turn(ctx, text),
        AgentKind::Aider => aider::build_turn(ctx, text),
        AgentKind::OpenCode => crate::agents::opencode::build_turn(ctx, text),
    }
}

/// `stream_deltas` must match what `build_turn` was given: at least one
/// CLI (Cursor) changes the *meaning* of an existing event rather than
/// adding a new one — with partial output on, each `assistant` line is a
/// fragment instead of a finished block — so the parser cannot tell the
/// two apart from the line alone.
pub fn parse_line(
    kind: AgentKind,
    line: &str,
    cache: &mut ToolUseCache,
    stream_deltas: bool,
) -> (Vec<AgentEvent>, Option<String>) {
    match kind {
        AgentKind::ClaudeCode => claude::parse_line(line, cache, stream_deltas),
        AgentKind::CursorAgent => cursor_agent::parse_line(line, cache, stream_deltas),
        AgentKind::Codex => codex::parse_line(line, cache),
        AgentKind::Aider => aider::parse_line(line, cache, stream_deltas),
        AgentKind::OpenCode => crate::agents::opencode::parse_line(line, cache, stream_deltas),
    }
}
