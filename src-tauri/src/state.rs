use crate::agents::adapter::PermissionMode;
use crate::agents::{AgentKind, CliStatus};
use crate::lsp::{LspProcessKey, LspServerEntry, LspServerKind, LspServerStatus};
use crate::terminal::TerminalHandle;
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
    /// Latched for the whole of `run_turn`, from before the spawn until
    /// after the child is reaped. `cancel_tx`/`pid` can't serve this role:
    /// both are cleared by an interrupt while the child is still winding
    /// down, which left a window where a second turn could start on top of
    /// the first.
    pub turn_active: bool,
    /// `Some` only while a turn's child process is actually running.
    pub cancel_tx: Option<Sender<AgentCancelKind>>,
    /// The current turn's child pid, tracked for the Process Manager
    /// (`processes.rs`) — `Some` exactly when `cancel_tx` is, since both
    /// are set and cleared by the same `run_turn` bookkeeping. Kept as a
    /// separate field rather than derived from `cancel_tx` because a
    /// `oneshot::Sender` has no idea what process it cancels.
    pub pid: Option<u32>,
    /// When this run (the tab, not the current turn) was created.
    pub started_at_ms: u64,
}

/// One in-flight worktree hook run — the cancel signal
/// `cancel_worktree_hook` needs, plus the reporting fields the Process
/// Manager needs. Keyed by worktree id in `AppState::hook_runs`; only one
/// hook runs per worktree at a time.
pub struct HookRunEntry {
    pub cancel_tx: Sender<()>,
    pub pid: Option<u32>,
    pub started_at_ms: u64,
    pub worktree_path: String,
    pub branch: String,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    /// Maestro's own data directory. Agent-owned session state
    /// lives here — currently Aider's chat-history files, which
    /// stand in for the session ids that CLI doesn't have.
    pub app_data_dir: std::path::PathBuf,
    /// In-flight hook runs, keyed by worktree id — carrying a one-shot
    /// cancel signal so `cancel_worktree_hook` can stop one without
    /// needing to hand the running `Child` itself across the command
    /// boundary.
    pub hook_runs: Mutex<HashMap<String, HookRunEntry>>,
    /// Live file watchers, keyed by worktree id — one per *open* worktree,
    /// not all worktrees at once (see docs/ROADMAP.md Phase 3). Dropping a
    /// worktree's entry stops its watcher.
    pub watchers: Mutex<HashMap<String, crate::watcher::WorktreeWatcher>>,
    /// Cached CLI detection results, keyed by kind — the centralized
    /// availability service every feature (agent tabs, commit-message
    /// generation) reads from rather than re-shelling out per mount.
    pub agent_status_cache: Mutex<HashMap<AgentKind, CliStatus>>,
    /// Server availability probes are independent of live LSP processes.
    /// The transport milestone will add a separate `(worktree, server)` map;
    /// this cache only prevents repeated version subprocesses on UI mounts.
    pub lsp_status_cache: Mutex<HashMap<LspServerKind, LspServerStatus>>,
    /// Live language servers, one per `(worktree, language adapter)`. Child
    /// ownership stays inside each server's Tokio supervisor; this map holds
    /// the bounded control channel and generation used for race-safe cleanup.
    pub lsp_servers: Mutex<HashMap<LspProcessKey, LspServerEntry>>,
    /// Live agent tab runs, keyed by run id (== the tab id).
    pub agent_runs: Mutex<HashMap<String, AgentRunEntry>>,
    /// Live terminal tabs, keyed by terminal id (== the tab id).
    pub terminals: Mutex<HashMap<String, TerminalHandle>>,
    /// Cooperative cancel flags for in-flight text searches, keyed by
    /// search id — polled between files (see `search.rs::search_in_files`)
    /// rather than a `oneshot::Sender` like the hook-cancel path, since a
    /// search isn't a single child process to kill, just a loop to stop.
    pub search_cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// The lazy `opencode serve` supervisor (docs/OPENCODE_INTEGRATION.md
    /// §2). App-global, not per worktree — the server is project-agnostic
    /// for auth/provider purposes and turns scope themselves via `--dir`.
    /// Starts `Stopped` and must only ever be acquired by opencode
    /// features; detection and app startup never touch it.
    pub opencode_sidecar: crate::agents::opencode::OpencodeSidecar,
    /// Guards held on behalf of the frontend — one per OpenCode settings
    /// pane currently mounted (§2.2's "pane visible" consumer). Commands
    /// that can't hold a guard across IPC mint a token here instead:
    /// `opencode_sidecar_acquire` stores the guard, the pane releases it
    /// on unmount. Keyed by token so two panes (satellite windows) don't
    /// cancel each other out.
    pub opencode_guards: Mutex<HashMap<u64, crate::agents::opencode::SidecarGuard>>,
    /// In-memory provider catalog cache with TTL (§2.3) — 193 entries
    /// shouldn't refetch because the user closed and reopened the modal,
    /// but must never outlive its usefulness. Invalidated by every
    /// connect/disconnect.
    pub opencode_provider_cache: Mutex<
        Option<(
            std::time::Instant,
            crate::agents::opencode::providers::ProviderOverview,
        )>,
    >,
    /// Providers successfully disconnected recently. Phase O4 live
    /// testing found that a running server's `/provider.connected` list
    /// reflects *additions* instantly but keeps removed ids until
    /// restart — without this, a just-disconnected row would resurrect
    /// in the pane on every refresh. Entries age out; a fresh server
    /// (after app restart) makes them moot.
    pub opencode_recent_disconnects: Mutex<HashMap<String, std::time::Instant>>,
}
