use crate::commands::git::{scm_event_channel, ScmEvent};
use crate::git;
use crate::state::AppState;
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Path segments that never need live-watching — matches the presets
/// already assumed elsewhere (install-command detection, hook scripts).
/// Filtered in the debounce callback rather than via non-recursive
/// per-directory watches, which would be meaningfully more code for this
/// phase's scope (see docs/CHECKLIST.md Phase 3).
const IGNORED_DIR_SEGMENTS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "coverage",
];

/// How long the filesystem debouncer waits for a burst to settle. A little
/// longer than it used to be (250 ms): the cost of a burst is a full-repo
/// `git status`, so paying a bit more latency to collapse more edits into
/// one pass is a good trade. See docs/PERFORMANCE_AUDIT.md §2.2.
const DEBOUNCE_INTERVAL: Duration = Duration::from_millis(400);

/// Floor between two consecutive `git status` passes. Independent of the
/// debounce above, because the debouncer's window says nothing about how
/// long the status itself takes — on a large repo one pass can outlast
/// several windows, and without this floor those queue up back to back and
/// keep a core busy for as long as the churn lasts.
const STATUS_MIN_INTERVAL: Duration = Duration::from_millis(750);

/// Folds every burst already queued behind the current one into it, so a
/// backlog costs one status pass rather than one each.
fn drain_pending(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<(HashSet<String>, HashSet<String>)>,
    touched: &mut HashSet<String>,
    dirs: &mut HashSet<String>,
) {
    while let Ok((more_touched, more_dirs)) = rx.try_recv() {
        touched.extend(more_touched);
        dirs.extend(more_dirs);
    }
}

pub struct WorktreeWatcher {
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    watched_dirs: HashSet<PathBuf>,
    root: PathBuf,
}

impl WorktreeWatcher {
    fn watch_directory(&mut self, path: PathBuf) -> Result<(), String> {
        if self.watched_dirs.insert(path.clone()) {
            self.debouncer
                .watch(&path, RecursiveMode::NonRecursive)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn stop(self) {
        self.debouncer.stop_nonblocking();
    }
}

fn fs_event_channel(worktree_id: &str) -> String {
    format!("fs://{worktree_id}")
}

fn is_ignored(path: &Path) -> bool {
    path.components()
        .any(|c| IGNORED_DIR_SEGMENTS.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

fn rel_path(worktree_root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(worktree_root)
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

// See `git.rs::DiffContent`'s comment — enum-level `rename_all` doesn't
// cascade into struct-like variants' fields. This was the actual root
// cause behind the earlier "event.touchedPaths is undefined" crashes —
// every field here was serializing as snake_case, so the frontend guards
// added to survive that were silently discarding every real event too.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FsChangeEvent {
    #[serde(rename_all = "camelCase")]
    Changed {
        touched_paths: Vec<String>,
        changed_dirs: Vec<String>,
        status_map: HashMap<String, char>,
    },
}

/// Starts (or restarts) a debounced, recursive watcher for one worktree,
/// emitting consolidated `FsChangeEvent`s on `fs://{worktree_id}`. The
/// frontend stays reactive/dumb (mirrors `hookEvents.ts`'s pattern) —
/// touched-dir resolution and git-status recomputation both happen here,
/// not re-derived from raw paths on the frontend.
#[tauri::command]
pub async fn start_worktree_watcher(
    app: AppHandle,
    state: State<'_, AppState>,
    worktree_id: String,
    worktree_path: String,
) -> Result<(), String> {
    {
        let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
        watchers.remove(&worktree_id);
    }

    let root = PathBuf::from(&worktree_path);
    let watch_root = root.clone();

    // The debounce callback used to spawn a `git status` per burst. Under
    // sustained churn — a running build, a test watcher, an agent editing
    // files — that meant a full
    // `git status --porcelain=v2 --untracked-files=all` over the whole
    // worktree every debounce window, which on a large repo is the dominant
    // background CPU cost of simply having the app open
    // (docs/PERFORMANCE_AUDIT.md §2.2).
    //
    // Bursts are now handed to one long-lived pacing task per watcher,
    // which coalesces everything queued behind it into a single status pass
    // and enforces a floor between passes. A trailing pass always runs, so
    // the last edit of a burst is never the one that gets dropped — this
    // adds latency under load, never staleness. A single edit on an
    // otherwise idle worktree still reports as soon as the debouncer fires.
    let (change_tx, mut change_rx) =
        tokio::sync::mpsc::unbounded_channel::<(HashSet<String>, HashSet<String>)>();

    let pacer_app = app.clone();
    let pacer_worktree_id = worktree_id.clone();
    let pacer_root = root.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_run: Option<Instant> = None;

        // Ends when the sender drops, which happens when the debouncer (and
        // with it this closure's captured `change_tx`) is dropped out of
        // `AppState.watchers` — no separate shutdown signal needed.
        while let Some((mut touched, mut dirs)) = change_rx.recv().await {
            drain_pending(&mut change_rx, &mut touched, &mut dirs);

            if let Some(previous) = last_run {
                let elapsed = previous.elapsed();
                if elapsed < STATUS_MIN_INTERVAL {
                    tokio::time::sleep(STATUS_MIN_INTERVAL - elapsed).await;
                    // Anything that arrived while waiting folds into this
                    // same pass rather than earning one of its own.
                    drain_pending(&mut change_rx, &mut touched, &mut dirs);
                }
            }

            // One `git status` call feeds both events — `.git/` is
            // watcher-ignored (see IGNORED_DIR_SEGMENTS), so this fs
            // watcher is the *only* thing that keeps the SCM view fresh
            // off working-tree edits; mutating git commands
            // (commands/git.rs) push their own `scm://` snapshot
            // separately, since staging/committing never touches a
            // watched path.
            let status = git::working_status(&pacer_root).await.unwrap_or_default();
            let status_map = git::status_glyphs(&status);
            last_run = Some(Instant::now());

            let _ = pacer_app.emit(
                &fs_event_channel(&pacer_worktree_id),
                FsChangeEvent::Changed {
                    touched_paths: touched.into_iter().collect(),
                    changed_dirs: dirs.into_iter().collect(),
                    status_map,
                },
            );
            let _ = pacer_app.emit(
                &scm_event_channel(&pacer_worktree_id),
                ScmEvent::StatusChanged { status },
            );
        }
    });

    let debouncer = new_debouncer(
        DEBOUNCE_INTERVAL,
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };

            // A set, not a `Vec`: coalesced bursts routinely report the same
            // file several times, and the frontend re-stats every touched
            // path (`MonacoHost`'s external-change check).
            let mut touched_paths: HashSet<String> = HashSet::new();
            let mut changed_dirs: HashSet<String> = HashSet::new();
            for debounced in &events {
                for path in &debounced.event.paths {
                    if is_ignored(path) {
                        continue;
                    }
                    let Some(rel) = rel_path(&watch_root, path) else {
                        continue;
                    };
                    let dir = match Path::new(&rel).parent() {
                        Some(p) if !p.as_os_str().is_empty() => p.to_string_lossy().to_string(),
                        _ => String::new(),
                    };
                    changed_dirs.insert(dir);
                    touched_paths.insert(rel);
                }
            }
            if touched_paths.is_empty() {
                return;
            }

            let _ = change_tx.send((touched_paths, changed_dirs));
        },
    )
    .map_err(|e| e.to_string())?;

    let mut watcher = WorktreeWatcher {
        debouncer,
        watched_dirs: HashSet::new(),
        root: root.clone(),
    };
    watcher.watch_directory(root)?;

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(worktree_id, watcher);
    Ok(())
}

/// Adds one explorer-visible directory to the non-recursive watch set. This
/// makes watcher cost proportional to directories the user is actually
/// working in instead of every directory in a potentially multi-gigabyte
/// monorepo.
#[tauri::command]
pub async fn watch_worktree_directory(
    state: State<'_, AppState>,
    worktree_id: String,
    rel_dir: String,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|error| error.to_string())?;
    let watcher = watchers
        .get_mut(&worktree_id)
        .ok_or("Worktree watcher is not running.")?;
    let directory = crate::fs_ops::safe_join(&watcher.root, &rel_dir)?;
    if is_ignored(&directory) {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Watch target must be a real directory.".to_string());
    }
    watcher.watch_directory(directory)
}

#[tauri::command]
pub async fn stop_worktree_watcher(
    state: State<'_, AppState>,
    worktree_id: String,
) -> Result<(), String> {
    let debouncer = {
        let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
        watchers.remove(&worktree_id)
    };
    if let Some(debouncer) = debouncer {
        debouncer.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ignored_paths_match_generated_and_dependency_trees() {
        let root = TempDir::new().unwrap();
        assert!(!is_ignored(&root.path().join("src/components")));
        assert!(is_ignored(&root.path().join("node_modules/pkg/deep")));
        assert!(is_ignored(&root.path().join("apps/web/.next/cache")));
    }
}
