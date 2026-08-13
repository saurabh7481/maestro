use crate::git;
use crate::models::Worktree;
use crate::state::AppState;
use rusqlite::params;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::State;

/// Reconciles the `worktrees` cache table against `git worktree list`
/// (the source of truth) and returns the current, status-annotated list.
/// Rows for worktrees git no longer reports are dropped; rows for
/// worktrees git newly reports (e.g. created via a plain `git` command in
/// a terminal, outside Maestro) are added. See docs/ARCHITECTURE.md §7.
async fn reconcile_and_list(
    state: &State<'_, AppState>,
    project_id: &str,
    repo_path: &str,
) -> Result<Vec<Worktree>, String> {
    let repo_dir = PathBuf::from(repo_path);
    let entries = git::list_worktrees(&repo_dir).await?;

    let ids: HashMap<String, String> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;

        for entry in &entries {
            let path_str = entry.path.to_string_lossy().to_string();
            let is_primary = path_str == repo_path;
            let branch = entry.branch.clone().unwrap_or_else(|| "HEAD".to_string());
            let id = uuid::Uuid::new_v4().to_string();
            let created_at = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO worktrees (id, project_id, path, branch, is_primary, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(project_id, path) DO UPDATE SET
                   branch = excluded.branch, is_primary = excluded.is_primary",
                params![id, project_id, path_str, branch, is_primary, created_at],
            )
            .map_err(|e| e.to_string())?;
        }

        let known_paths: HashSet<String> = entries
            .iter()
            .map(|e| e.path.to_string_lossy().to_string())
            .collect();
        let mut stmt = conn
            .prepare("SELECT id, path FROM worktrees WHERE project_id = ?1")
            .map_err(|e| e.to_string())?;
        let all: Vec<(String, String)> = stmt
            .query_map(params![project_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;

        let mut ids = HashMap::new();
        for (id, path) in all {
            if known_paths.contains(&path) {
                ids.insert(path, id);
            } else {
                conn.execute("DELETE FROM worktrees WHERE id = ?1", params![id])
                    .ok();
            }
        }
        ids
    };

    let mut results = Vec::with_capacity(entries.len());
    for entry in entries {
        let path_str = entry.path.to_string_lossy().to_string();
        let Some(id) = ids.get(&path_str).cloned() else {
            continue;
        };
        let is_primary = path_str == repo_path;
        let branch = entry.branch.unwrap_or_else(|| "HEAD".to_string());
        let status = if entry.is_bare {
            git::StatusSummary::default()
        } else {
            git::status_summary(&entry.path).await
        };
        results.push(Worktree {
            id,
            project_id: project_id.to_string(),
            path: path_str,
            branch,
            is_primary,
            is_detached: entry.is_detached,
            is_locked: entry.is_locked,
            ahead: status.ahead,
            behind: status.behind,
            dirty: status.dirty,
            changed_files: status.changed_files,
        });
    }

    Ok(results)
}

fn project_root_path(state: &State<'_, AppState>, project_id: &str) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT root_path FROM projects WHERE id = ?1",
        params![project_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_worktrees(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Worktree>, String> {
    let repo_path = project_root_path(&state, &project_id)?;
    reconcile_and_list(&state, &project_id, &repo_path).await
}

#[tauri::command]
pub async fn list_project_branches(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let repo_path = project_root_path(&state, &project_id)?;
    git::list_branches(&PathBuf::from(repo_path)).await
}

#[tauri::command]
pub async fn create_worktree(
    state: State<'_, AppState>,
    project_id: String,
    branch_name: String,
    base_ref: String,
) -> Result<Worktree, String> {
    let repo_path = project_root_path(&state, &project_id)?;
    let repo_dir = PathBuf::from(&repo_path);

    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

    let repo_name = repo_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());
    let parent = repo_dir.parent().ok_or("Project has no parent directory")?;
    let worktree_path = parent
        .join(format!("{repo_name}.worktrees"))
        .join(branch_name);

    if worktree_path.exists() {
        return Err(format!("{} already exists", worktree_path.display()));
    }

    let existing_branches = git::list_branches(&repo_dir).await?;
    let create_branch = !existing_branches.iter().any(|b| b == branch_name);

    git::worktree_add(
        &repo_dir,
        &worktree_path,
        branch_name,
        &base_ref,
        create_branch,
    )
    .await?;

    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    let worktrees = reconcile_and_list(&state, &project_id, &repo_path).await?;
    worktrees
        .into_iter()
        .find(|w| w.path == worktree_path_str)
        .ok_or_else(|| "Worktree created but not found on reconcile".to_string())
}

#[tauri::command]
pub async fn remove_worktree(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: String,
    force: bool,
) -> Result<(), String> {
    let repo_path = project_root_path(&state, &project_id)?;
    let worktree_path: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT path FROM worktrees WHERE id = ?1",
            params![worktree_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?
    };

    let repo_dir = PathBuf::from(&repo_path);
    let wt_dir = PathBuf::from(&worktree_path);

    if wt_dir == repo_dir {
        return Err("Cannot remove the project's primary worktree".to_string());
    }

    if !force && git::is_dirty(&wt_dir).await {
        return Err("Worktree has uncommitted changes".to_string());
    }

    git::worktree_remove(&repo_dir, &wt_dir, force).await?;

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM worktrees WHERE id = ?1", params![worktree_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn touch_worktree(state: State<'_, AppState>, worktree_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE worktrees SET last_opened_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), worktree_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
