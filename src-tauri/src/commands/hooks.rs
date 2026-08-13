use crate::models::HookConfig;
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

fn hook_event_channel(worktree_id: &str) -> String {
    format!("hook://{worktree_id}")
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HookEvent {
    Line {
        stream: &'static str,
        text: String,
    },
    Done {
        exit_code: Option<i32>,
        success: bool,
        cancelled: bool,
        timed_out: bool,
    },
}

fn read_hook_config(conn: &rusqlite::Connection, project_id: &str) -> Result<HookConfig, String> {
    conn.query_row(
        "SELECT copy_env_files, run_install_command, install_command, symlink_node_modules, custom_script_enabled, custom_script
         FROM worktree_hooks WHERE project_id = ?1",
        params![project_id],
        |row| {
            Ok(HookConfig {
                copy_env_files: row.get(0)?,
                run_install_command: row.get(1)?,
                install_command: row.get(2)?,
                symlink_node_modules: row.get(3)?,
                custom_script_enabled: row.get(4)?,
                custom_script: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|c| c.unwrap_or_default())
}

#[tauri::command]
pub async fn get_hook_config(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<HookConfig, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    read_hook_config(&conn, &project_id)
}

#[tauri::command]
pub async fn set_hook_config(
    state: State<'_, AppState>,
    project_id: String,
    config: HookConfig,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO worktree_hooks (project_id, copy_env_files, run_install_command, install_command, symlink_node_modules, custom_script_enabled, custom_script)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_id) DO UPDATE SET
           copy_env_files = excluded.copy_env_files,
           run_install_command = excluded.run_install_command,
           install_command = excluded.install_command,
           symlink_node_modules = excluded.symlink_node_modules,
           custom_script_enabled = excluded.custom_script_enabled,
           custom_script = excluded.custom_script",
        params![
            project_id,
            config.copy_env_files,
            config.run_install_command,
            config.install_command,
            config.symlink_node_modules,
            config.custom_script_enabled,
            config.custom_script,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Unix-shell hook script assembled from the enabled presets + custom
/// script. v1 is Linux-first (docs/V1_SCOPE.md) — Windows-compatible hook
/// generation is a v2 concern, not attempted here.
fn build_hook_script(config: &HookConfig) -> String {
    let mut parts = Vec::new();
    if config.copy_env_files {
        // `cp` is silent on success and stderr is suppressed on purpose
        // (no .env files to copy isn't a failure) — echo either way so the
        // streamed output panel shows what happened instead of nothing.
        parts.push(
            r#"if cp "$SOURCE_WORKTREE"/.env* "$NEW_WORKTREE"/ 2>/dev/null; then echo "Copied .env files from $SOURCE_WORKTREE"; else echo "No .env files found in $SOURCE_WORKTREE"; fi"#
                .to_string(),
        );
    }
    if config.symlink_node_modules {
        parts.push(
            r#"if [ -d "$SOURCE_WORKTREE/node_modules" ]; then ln -s "$SOURCE_WORKTREE/node_modules" "$NEW_WORKTREE/node_modules" && echo "Symlinked node_modules"; else echo "No node_modules found in $SOURCE_WORKTREE to symlink"; fi"#
                .to_string(),
        );
    }
    if config.run_install_command {
        if let Some(cmd) = &config.install_command {
            if !cmd.trim().is_empty() {
                parts.push(cmd.clone());
            }
        }
    }
    if config.custom_script_enabled && !config.custom_script.trim().is_empty() {
        parts.push(config.custom_script.clone());
    }
    parts.join("\n")
}

#[tauri::command]
pub async fn run_worktree_hook(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: String,
    source_worktree_path: String,
) -> Result<(), String> {
    let (config, worktree_path, branch, repo_path) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let config = read_hook_config(&conn, &project_id)?;
        let (worktree_path, branch): (String, String) = conn
            .query_row(
                "SELECT path, branch FROM worktrees WHERE id = ?1",
                params![worktree_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        let repo_path: String = conn
            .query_row(
                "SELECT root_path FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        (config, worktree_path, branch, repo_path)
    };

    let script = build_hook_script(&config);
    let channel = hook_event_channel(&worktree_id);
    if script.trim().is_empty() {
        let _ = app.emit(
            &channel,
            HookEvent::Done {
                exit_code: Some(0),
                success: true,
                cancelled: false,
                timed_out: false,
            },
        );
        return Ok(());
    }

    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(&script)
        .current_dir(&worktree_path)
        .env("NEW_WORKTREE", &worktree_path)
        .env("SOURCE_WORKTREE", &source_worktree_path)
        .env("BRANCH", &branch)
        .env("PROJECT_ROOT", &repo_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("failed to capture hook stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture hook stderr")?;

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let _ = stdout_app.emit(
                &stdout_channel,
                HookEvent::Line {
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
                HookEvent::Line {
                    stream: "stderr",
                    text,
                },
            );
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut senders = state
            .hook_cancel_senders
            .lock()
            .map_err(|e| e.to_string())?;
        senders.insert(worktree_id.clone(), cancel_tx);
    }

    let timeout = tokio::time::Duration::from_secs(120);
    let (exit_code, cancelled, timed_out) = tokio::select! {
        result = tokio::time::timeout(timeout, child.wait()) => match result {
            Ok(Ok(status)) => (status.code(), false, false),
            Ok(Err(_)) => (None, false, false),
            Err(_) => {
                let _ = child.kill().await;
                (None, false, true)
            }
        },
        _ = &mut cancel_rx => {
            let _ = child.kill().await;
            (None, true, false)
        }
    };

    {
        let mut senders = state
            .hook_cancel_senders
            .lock()
            .map_err(|e| e.to_string())?;
        senders.remove(&worktree_id);
    }

    let success = exit_code == Some(0) && !cancelled && !timed_out;
    let _ = app.emit(
        &channel,
        HookEvent::Done {
            exit_code,
            success,
            cancelled,
            timed_out,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn cancel_worktree_hook(
    state: State<'_, AppState>,
    worktree_id: String,
) -> Result<(), String> {
    let sender = {
        let mut senders = state
            .hook_cancel_senders
            .lock()
            .map_err(|e| e.to_string())?;
        senders.remove(&worktree_id)
    };
    if let Some(tx) = sender {
        let _ = tx.send(());
    }
    Ok(())
}
