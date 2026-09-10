use crate::git;
use crate::models::Project;
use crate::process_ext::HiddenCommandExt;
use crate::state::{AppState, CloneRunEntry};
use rusqlite::{params, OptionalExtension};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

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

/// Core of `add_project` — a git-repo path already on disk gets registered
/// as a project. Extracted so `clone_project` below can reuse the exact
/// same validation/insert logic once `git clone` finishes, rather than
/// duplicating it. Takes `&AppState` (not an already-locked connection) so
/// the async `is_git_repo` check happens *before* any lock is taken —
/// holding `state.db`'s `std::sync::MutexGuard` across an `.await` is both
/// a `Send`-future hazard and blocks every other DB user for no reason.
async fn add_project_inner(state: &AppState, path: &str) -> Result<Project, String> {
    let root_path = PathBuf::from(path);
    if !git::is_git_repo(&root_path).await {
        return Err(format!("{path} is not a git repository"));
    }
    let install_command = git::detect_install_command(&root_path);

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let already_added: Option<String> = conn
        .query_row(
            "SELECT id FROM projects WHERE root_path = ?1",
            params![path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if already_added.is_some() {
        return Err("This project has already been added".to_string());
    }

    let name = root_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let id = uuid::Uuid::new_v4().to_string();
    let added_at = chrono::Utc::now().to_rfc3339();

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
        root_path: path.to_string(),
        added_at,
    })
}

#[tauri::command]
pub async fn add_project(state: State<'_, AppState>, path: String) -> Result<Project, String> {
    add_project_inner(&state, &path).await
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

fn clone_event_channel(clone_id: &str) -> String {
    format!("clone://{clone_id}")
}

/// Same shape as `commands::hooks::HookEvent` — a streamed subprocess's
/// output lines followed by one completion event — plus `project`, which
/// carries the newly-registered `Project` on success so the frontend can
/// add it to the workspace store without a second round trip.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum CloneEvent {
    #[serde(rename_all = "camelCase")]
    Line { stream: &'static str, text: String },
    #[serde(rename_all = "camelCase")]
    Done {
        exit_code: Option<i32>,
        success: bool,
        cancelled: bool,
        project: Option<Project>,
    },
}

/// Clones `url` into `destination` (a not-yet-existing directory under a
/// parent the user picked — see `pick_project_folder`, reused as-is for
/// that picker) and, on success, registers it exactly like `add_project`
/// would. Streams `git clone --progress`'s stdout/stderr live on
/// `clone://{clone_id}`, mirroring `hooks::run_worktree_hook`'s streamed
/// subprocess pattern. No pre-check on `destination`: `git clone` itself
/// refuses a non-empty existing directory, and that error arrives as an
/// ordinary `Line` event instead of a second, redundant check here.
#[tauri::command]
pub async fn clone_project(
    app: AppHandle,
    state: State<'_, AppState>,
    clone_id: String,
    url: String,
    destination: String,
) -> Result<(), String> {
    let channel = clone_event_channel(&clone_id);

    let mut command = Command::new("git");
    command
        .args(["clone", "--progress", &url, &destination])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .hide_window();

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = app.emit(
                &channel,
                CloneEvent::Line {
                    stream: "stderr",
                    text: format!("failed to run git: {error}"),
                },
            );
            let _ = app.emit(
                &channel,
                CloneEvent::Done {
                    exit_code: None,
                    success: false,
                    cancelled: false,
                    project: None,
                },
            );
            return Ok(());
        }
    };
    // `git clone --progress` writes its progress meter to stderr even on
    // success (stdout is typically empty) — both are forwarded verbatim
    // and the frontend doesn't need to treat either specially.
    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture clone stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("failed to capture clone stderr")?;

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let _ = stdout_app.emit(
                &stdout_channel,
                CloneEvent::Line {
                    stream: "stdout",
                    text,
                },
            );
        }
    });
    let stderr_app = app.clone();
    let stderr_channel = channel.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let _ = stderr_app.emit(
                &stderr_channel,
                CloneEvent::Line {
                    stream: "stderr",
                    text,
                },
            );
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut runs = state.clone_runs.lock().map_err(|e| e.to_string())?;
        runs.insert(clone_id.clone(), CloneRunEntry { cancel_tx });
    }

    let (exit_code, cancelled) = tokio::select! {
        result = child.wait() => (result.ok().and_then(|status| status.code()), false),
        _ = &mut cancel_rx => {
            let _ = child.kill().await;
            (None, true)
        }
    };

    {
        let mut runs = state.clone_runs.lock().map_err(|e| e.to_string())?;
        runs.remove(&clone_id);
    }

    let project = if exit_code == Some(0) && !cancelled {
        match add_project_inner(&state, &destination).await {
            Ok(project) => Some(project),
            Err(error) => {
                let _ = app.emit(
                    &channel,
                    CloneEvent::Line {
                        stream: "stderr",
                        text: error,
                    },
                );
                None
            }
        }
    } else {
        None
    };
    let success = project.is_some();
    let _ = app.emit(
        &channel,
        CloneEvent::Done {
            exit_code,
            success,
            cancelled,
            project,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn cancel_project_clone(
    state: State<'_, AppState>,
    clone_id: String,
) -> Result<(), String> {
    let entry = {
        let mut runs = state.clone_runs.lock().map_err(|e| e.to_string())?;
        runs.remove(&clone_id)
    };
    if let Some(entry) = entry {
        let _ = entry.cancel_tx.send(());
    }
    Ok(())
}
