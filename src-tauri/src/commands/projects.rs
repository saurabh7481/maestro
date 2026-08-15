use crate::git;
use crate::models::Project;
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, root_path, added_at FROM projects ORDER BY added_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                added_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_project_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
pub async fn add_project(state: State<'_, AppState>, path: String) -> Result<Project, String> {
    let root_path = PathBuf::from(&path);
    if !git::is_git_repo(&root_path).await {
        return Err(format!("{path} is not a git repository"));
    }

    let already_added: Option<String> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM projects WHERE root_path = ?1",
            params![path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    if already_added.is_some() {
        return Err("This project has already been added".to_string());
    }

    let name = root_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let added_at = chrono::Utc::now().to_rfc3339();
    let install_command = git::detect_install_command(&root_path);

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO projects (id, name, root_path, added_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, path, added_at],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO worktree_hooks (project_id, install_command) VALUES (?1, ?2)",
        params![id, install_command],
    )
    .map_err(|e| e.to_string())?;

    Ok(Project {
        id,
        name,
        root_path: path,
        added_at,
    })
}

#[tauri::command]
pub async fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renames a project's *display name* only — the `name` column shown in
/// the sidebar, not the folder on disk. `root_path` (and every worktree's
/// actual path under it) is untouched, matching how the context menu that
/// calls this describes it: "Rename (locally)".
#[tauri::command]
pub async fn rename_project(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name must not be empty".to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE projects SET name = ?1 WHERE id = ?2",
        params![name, project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
