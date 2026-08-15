use crate::search;
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn search_event_channel(search_id: &str) -> String {
    format!("search://{search_id}")
}

// See `git.rs::DiffContent`'s comment — enum-level `rename_all` doesn't
// cascade into struct-like variants' fields, each needs its own.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SearchEvent {
    /// A round of scanned files, not a single file — one event per batch
    /// keeps a broad query from emitting thousands of individual IPC
    /// messages the renderer has to deserialize and reduce over
    /// (docs/PERFORMANCE_AUDIT.md §2.4).
    #[serde(rename_all = "camelCase")]
    Match { files: Vec<search::FileMatches> },
    #[serde(rename_all = "camelCase")]
    Done {
        files_matched: u32,
        cancelled: bool,
        /// The scan hit `search::MAX_MATCHED_FILES` and stopped with files
        /// left unscanned.
        truncated: bool,
    },
}

#[tauri::command]
pub async fn list_files(worktree_root: String) -> Result<Vec<String>, String> {
    search::list_files(&PathBuf::from(worktree_root)).await
}

/// Streams progressive `Match` events on `search://{search_id}` as files
/// are scanned, resolving with `Ok(())` after emitting a final `Done` —
/// mirrors `hooks.rs::run_worktree_hook`'s streaming-command shape (a
/// paired `cancel_search` below plays the same role as
/// `cancel_worktree_hook`).
#[tauri::command]
pub async fn search_in_files(
    app: AppHandle,
    state: State<'_, AppState>,
    search_id: String,
    worktree_root: String,
    query: String,
    options: search::SearchOptions,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state
            .search_cancel_flags
            .lock()
            .map_err(|e| e.to_string())?;
        flags.insert(search_id.clone(), cancel.clone());
    }

    let channel = search_event_channel(&search_id);
    let emit_app = app.clone();
    let emit_channel = channel.clone();
    let result = search::search_in_files(
        &PathBuf::from(worktree_root),
        &query,
        &options,
        &cancel,
        |files| {
            let _ = emit_app.emit(&emit_channel, SearchEvent::Match { files });
        },
    )
    .await;

    {
        let mut flags = state
            .search_cancel_flags
            .lock()
            .map_err(|e| e.to_string())?;
        flags.remove(&search_id);
    }

    let cancelled = cancel.load(Ordering::Relaxed);
    let outcome = result?;
    let _ = app.emit(
        &channel,
        SearchEvent::Done {
            files_matched: outcome.files_matched,
            cancelled,
            truncated: outcome.truncated,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn cancel_search(state: State<'_, AppState>, search_id: String) -> Result<(), String> {
    let flags = state
        .search_cancel_flags
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&search_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn replace_in_files(
    worktree_root: String,
    query: String,
    replacement: String,
    options: search::SearchOptions,
    files: Vec<String>,
) -> Result<search::ReplaceSummary, String> {
    search::replace_in_files(
        &PathBuf::from(worktree_root),
        &query,
        &replacement,
        &options,
        &files,
    )
    .await
}
