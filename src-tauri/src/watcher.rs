use crate::commands::git::{scm_event_channel, ScmEvent};
use crate::git;
use crate::state::AppState;
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
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
    let app_handle = app.clone();
    let event_worktree_id = worktree_id.clone();
    let watch_root = root.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };

            let mut touched_paths = Vec::new();
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
                    touched_paths.push(rel);
                }
            }
            if touched_paths.is_empty() {
                return;
            }

            let app = app_handle.clone();
            let worktree_id = event_worktree_id.clone();
            let root = watch_root.clone();
            tauri::async_runtime::spawn(async move {
                // One `git status` call feeds both events — `.git/` is
                // watcher-ignored (see IGNORED_DIR_SEGMENTS), so this fs
                // watcher is the *only* thing that keeps the SCM view fresh
                // off working-tree edits; mutating git commands
                // (commands/git.rs) push their own `scm://` snapshot
                // separately, since staging/committing never touches a
                // watched path.
                let status = git::working_status(&root).await.unwrap_or_default();
                let status_map = git::status_glyphs(&status);
                let _ = app.emit(
                    &fs_event_channel(&worktree_id),
                    FsChangeEvent::Changed {
                        touched_paths,
                        changed_dirs: changed_dirs.into_iter().collect(),
                        status_map,
                    },
                );
                let _ = app.emit(
                    &scm_event_channel(&worktree_id),
                    ScmEvent::StatusChanged { status },
                );
            });
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(worktree_id, debouncer);
    Ok(())
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
        debouncer.stop_nonblocking();
    }
    Ok(())
}
