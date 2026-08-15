use crate::agents::adapter::PermissionMode;
use crate::agents::{AgentKind, CliStatus};
use crate::terminal::TerminalHandle;
use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot::Sender;

/// What a running (or just-finished) agent turn needs cancelled — see
/// `agents/manager.rs::run_turn`. `Soft` tries `SIGINT` first (Unix
/// only, falling back to a hard kill after a short grace period); `Hard`
/// kills immediately.
pub enum AgentCancelKind {
    Soft,
    Hard,
}

/// One (worktree, agent-tab) run's cross-turn state. A "turn" is its own
/// `--resume <session_id>` spawn (see `agents/manager.rs::run_turn` for
/// why this is simpler and more robust than keeping one long-lived
/// process's stdin open across turns) — this struct is what carries
/// continuity between those spawns.
pub struct AgentRunEntry {
    pub kind: AgentKind,
    pub worktree_id: String,
    pub worktree_root: String,
    pub session_id: Option<String>,
    /// User-picked model alias (e.g. `"sonnet"`, `"opus"`) — a real,
    /// confirmed CLI flag (`claude --help`'s `--model`), not a decorative
    /// picker (see docs/V1_SCOPE.md §6 "no fake dropdowns"). `None` lets
    /// the CLI use its own default.
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    /// Consumed by the first `run_turn` call after `start_agent_session`
    /// when resuming — `--fork-session` only makes sense on the turn that
    /// actually resumes, not on every subsequent turn (which by then is
    /// continuing the newly-forked session id anyway).
    pub pending_fork: bool,
    /// Grows as the user clicks "Always allow" on permission cards for
    /// this tab. Starts at `claude::DEFAULT_ALLOWED_TOOLS`.
    pub allowed_tools: Vec<String>,
    /// Defaults to `Manual` (gated, off-by-default opt-out per
    /// docs/CHECKLIST.md) — see `agents::adapter::PermissionMode`.
    pub permission_mode: PermissionMode,
    /// `Some` only while a turn's child process is actually running.
    pub cancel_tx: Option<Sender<AgentCancelKind>>,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    /// One-shot cancel signals for in-flight hook runs, keyed by worktree
    /// id, so `cancel_worktree_hook` can stop one without needing to hand
    /// the running `Child` itself across the command boundary.
    pub hook_cancel_senders: Mutex<HashMap<String, Sender<()>>>,
    /// Live file watchers, keyed by worktree id — one per *open* worktree,
    /// not all worktrees at once (see docs/ROADMAP.md Phase 3). Dropping a
    /// worktree's entry stops its watcher.
    pub watchers: Mutex<HashMap<String, Debouncer<RecommendedWatcher, RecommendedCache>>>,
    /// Cached CLI detection results, keyed by kind — the centralized
    /// availability service every feature (agent tabs, commit-message
    /// generation) reads from rather than re-shelling out per mount.
    pub agent_status_cache: Mutex<HashMap<AgentKind, CliStatus>>,
    /// Live agent tab runs, keyed by run id (== the tab id).
    pub agent_runs: Mutex<HashMap<String, AgentRunEntry>>,
    /// Live terminal tabs, keyed by terminal id (== the tab id).
    pub terminals: Mutex<HashMap<String, TerminalHandle>>,
    /// Cooperative cancel flags for in-flight text searches, keyed by
    /// search id — polled between files (see `search.rs::search_in_files`)
    /// rather than a `oneshot::Sender` like the hook-cancel path, since a
    /// search isn't a single child process to kill, just a loop to stop.
    pub search_cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
