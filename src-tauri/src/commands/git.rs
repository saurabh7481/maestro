use crate::fs_ops;
use crate::git::{
    self, CommitSummary, ConflictContent, DiffContent, DiffMode, StashEntry, StatusKind,
    WorkingStatus,
};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// `pub(crate)`, not private — `watcher.rs`'s debounce callback reuses
/// this exact channel/shape to emit `scm://` from the `WorkingStatus`
/// snapshot it computes for `fs://`'s glyph map, rather than shelling out
/// to `git status` a second time.
pub(crate) fn scm_event_channel(worktree_id: &str) -> String {
    format!("scm://{worktree_id}")
}

// See `git.rs::DiffContent`'s comment — enum-level `rename_all` doesn't
// cascade into struct-like variants' fields. Harmless here today (single
// word field), kept for consistency so a future added field doesn't
// silently reintroduce the bug.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ScmEvent {
    #[serde(rename_all = "camelCase")]
    StatusChanged { status: WorkingStatus },
}

/// `.git/` is deliberately excluded from the file watcher (see
/// `watcher.rs`), so `git add`/`commit`/`push`/`pull`/`fetch` never trigger
/// it — every mutating command below calls this itself on success so the
/// SCM view refreshes without waiting on a filesystem event that will
/// never come.
async fn emit_scm_status(app: &AppHandle, worktree_id: &str, worktree_root: &Path) {
    if let Ok(status) = git::working_status(worktree_root).await {
        let _ = app.emit(
            &scm_event_channel(worktree_id),
            ScmEvent::StatusChanged { status },
        );
    }
}

#[tauri::command]
pub async fn get_working_status(worktree_root: String) -> Result<WorkingStatus, String> {
    git::working_status(&PathBuf::from(worktree_root)).await
}

#[tauri::command]
pub async fn stage_paths(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    rel_paths: Vec<String>,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::stage_paths(&root, &rel_paths).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn stage_all(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::stage_all(&root).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn unstage_paths(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    rel_paths: Vec<String>,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::unstage_paths(&root, &rel_paths).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn unstage_all(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::unstage_all(&root).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

/// Discards changes to `rel_paths`. For a tracked file this is `git
/// restore`; for an untracked file (which `git restore` no-ops on, since
/// there's nothing checked-in to restore from) this deletes it directly,
/// reusing `fs_ops::safe_join`'s path-containment guard rather than a new
/// one. Untracked *directories* never appear here — `working_status` runs
/// with `--untracked-files=all`, so every untracked entry is a real file.
///
/// `working_status` is consulted once for the whole batch rather than per
/// path, and the tracked remainder restored in a single `git restore`.
async fn discard_rel_paths(root: &Path, rel_paths: &[String]) -> Result<(), String> {
    let status = git::working_status(root).await?;
    let untracked: HashSet<&str> = status
        .entries
        .iter()
        .filter(|e| matches!(e.unstaged, Some(StatusKind::Untracked)))
        .map(|e| e.path.as_str())
        .collect();

    let mut tracked: Vec<String> = Vec::new();
    for rel_path in rel_paths {
        if untracked.contains(rel_path.as_str()) {
            let path = fs_ops::safe_join(root, rel_path)?;
            tokio::fs::remove_file(&path)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            tracked.push(rel_path.clone());
        }
    }
    git::discard_unstaged_paths(root, &tracked).await
}

#[tauri::command]
pub async fn discard_change(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    rel_path: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    discard_rel_paths(&root, std::slice::from_ref(&rel_path)).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

/// Bulk form of `discard_change`, behind Source Control's "Discard all
/// changes". The caller passes the paths it is actually showing rather
/// than this doing a blanket `git restore . && git clean -fd`: conflicted
/// entries must not be swept up (`git restore` refuses a path that needs
/// merge, which would fail the whole batch), and neither must anything the
/// SCM view isn't listing.
#[tauri::command]
pub async fn discard_paths(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    rel_paths: Vec<String>,
) -> Result<(), String> {
    if rel_paths.is_empty() {
        return Ok(());
    }
    let root = PathBuf::from(worktree_root);
    discard_rel_paths(&root, &rel_paths).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn commit_changes(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    message: String,
) -> Result<String, String> {
    let root = PathBuf::from(worktree_root);
    let hash = git::commit(&root, &message).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(hash)
}

#[tauri::command]
pub async fn push_changes(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::push(&root).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn pull_changes(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::pull(&root).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn fetch_remote(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::fetch(&root).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn get_diff_content(
    worktree_root: String,
    rel_path: String,
    mode: DiffMode,
    commit_hash: Option<String>,
) -> Result<DiffContent, String> {
    git::diff_content(
        &PathBuf::from(worktree_root),
        &rel_path,
        mode,
        commit_hash.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn get_commit_log(
    worktree_root: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<CommitSummary>, String> {
    git::log(&PathBuf::from(worktree_root), limit, skip).await
}

#[tauri::command]
pub async fn get_commit_files(
    worktree_root: String,
    hash: String,
) -> Result<Vec<(String, StatusKind)>, String> {
    git::commit_files(&PathBuf::from(worktree_root), &hash).await
}

#[tauri::command]
pub async fn get_conflict_content(
    worktree_root: String,
    rel_path: String,
) -> Result<ConflictContent, String> {
    git::conflict_content(&PathBuf::from(worktree_root), &rel_path).await
}

#[tauri::command]
pub async fn resolve_conflict(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    rel_path: String,
    result: String,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::resolve_conflict(&root, &rel_path, &result).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn list_stashes(worktree_root: String) -> Result<Vec<StashEntry>, String> {
    git::list_stashes(&PathBuf::from(worktree_root)).await
}

#[tauri::command]
pub async fn create_stash(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    message: String,
    include_untracked: bool,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    git::create_stash(&root, &message, include_untracked).await?;
    emit_scm_status(&app, &worktree_id, &root).await;
    Ok(())
}

#[tauri::command]
pub async fn apply_stash(
    app: AppHandle,
    worktree_id: String,
    worktree_root: String,
    reference: String,
    pop: bool,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_root);
    let result = git::apply_stash(&root, &reference, pop).await;
    // Applying can legitimately stop on conflicts. Emit even on failure so
    // the conflict section and merge editor become available immediately.
    emit_scm_status(&app, &worktree_id, &root).await;
    result
}

#[tauri::command]
pub async fn drop_stash(worktree_root: String, reference: String) -> Result<(), String> {
    git::drop_stash(&PathBuf::from(worktree_root), &reference).await
}

#[tauri::command]
pub async fn get_stash_files(
    worktree_root: String,
    reference: String,
) -> Result<Vec<(String, StatusKind)>, String> {
    git::stash_files(&PathBuf::from(worktree_root), &reference).await
}
