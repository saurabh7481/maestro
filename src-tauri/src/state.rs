use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot::Sender;

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
}
