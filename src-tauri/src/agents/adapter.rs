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
use crate::agents::{claude, codex, cursor_agent};
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
    #[default]
    Manual,
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
    pub permission_mode: PermissionMode,
}

pub struct TurnSpawn {
    pub command: Command,
    /// `Some` when the prompt must be written to the child's stdin (and
    /// stdin then closed) after spawn — only Claude's `--input-format
    /// stream-json` needs this; Cursor and Codex take the prompt as a
    /// plain argv argument.
    pub stdin_payload: Option<String>,
}

pub fn build_turn(kind: AgentKind, ctx: &TurnCtx, text: &str) -> TurnSpawn {
    match kind {
        AgentKind::ClaudeCode => claude::build_turn(ctx, text),
        AgentKind::CursorAgent => cursor_agent::build_turn(ctx, text),
        AgentKind::Codex => codex::build_turn(ctx, text),
    }
}

pub fn parse_line(
    kind: AgentKind,
    line: &str,
    cache: &mut ToolUseCache,
) -> (Vec<AgentEvent>, Option<String>) {
    match kind {
        AgentKind::ClaudeCode => claude::parse_line(line, cache),
        AgentKind::CursorAgent => cursor_agent::parse_line(line, cache),
        AgentKind::Codex => codex::parse_line(line, cache),
    }
}
