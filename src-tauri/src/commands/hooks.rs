use crate::models::HookConfig;
use crate::process_ext::HiddenCommandExt;
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

fn hook_event_channel(worktree_id: &str) -> String {
    format!("hook://{worktree_id}")
}

// See `git.rs::DiffContent`'s comment — enum-level `rename_all` doesn't
// cascade into struct-like variants' fields, each needs its own.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HookEvent {
    #[serde(rename_all = "camelCase")]
    Line { stream: &'static str, text: String },
    #[serde(rename_all = "camelCase")]
    Done {
        exit_code: Option<i32>,
        success: bool,
        cancelled: bool,
        timed_out: bool,
    },
}

fn read_hook_config(conn: &rusqlite::Connection, project_id: &str) -> Result<HookConfig, String> {
    conn.query_row(
        "SELECT copy_env_files, run_install_command, install_command, symlink_node_modules, custom_script_enabled, custom_script, override_enabled
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
                override_enabled: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|c| c.unwrap_or_default())
}

/// The global default hook config — applied to any project whose own
/// `worktree_hooks` row doesn't have `override_enabled` set. Its own
/// `override_enabled` field is meaningless (always `false`): the global
/// config has nothing to override.
fn read_global_hook_config(conn: &rusqlite::Connection) -> Result<HookConfig, String> {
    conn.query_row(
        "SELECT copy_env_files, run_install_command, install_command, symlink_node_modules, custom_script_enabled, custom_script
         FROM global_worktree_hooks WHERE id = 1",
        [],
        |row| {
            Ok(HookConfig {
                copy_env_files: row.get(0)?,
                run_install_command: row.get(1)?,
                install_command: row.get(2)?,
                symlink_node_modules: row.get(3)?,
                custom_script_enabled: row.get(4)?,
                custom_script: row.get(5)?,
                override_enabled: false,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|c| c.unwrap_or_default())
}

/// The config that actually governs a project's worktree hooks: its own,
/// if it opted in via `override_enabled`, otherwise the global default.
/// The one place `run_worktree_hook` (and anything else that needs "what
/// hooks apply to this project") should resolve that from.
fn resolve_effective_hook_config(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<HookConfig, String> {
    let project_config = read_hook_config(conn, project_id)?;
    if project_config.override_enabled {
        Ok(project_config)
    } else {
        read_global_hook_config(conn)
    }
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
        "INSERT INTO worktree_hooks (project_id, copy_env_files, run_install_command, install_command, symlink_node_modules, custom_script_enabled, custom_script, override_enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_id) DO UPDATE SET
           copy_env_files = excluded.copy_env_files,
           run_install_command = excluded.run_install_command,
           install_command = excluded.install_command,
           symlink_node_modules = excluded.symlink_node_modules,
           custom_script_enabled = excluded.custom_script_enabled,
           custom_script = excluded.custom_script,
           override_enabled = excluded.override_enabled",
        params![
            project_id,
            config.copy_env_files,
            config.run_install_command,
            config.install_command,
            config.symlink_node_modules,
            config.custom_script_enabled,
            config.custom_script,
            config.override_enabled,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_global_hook_config(state: State<'_, AppState>) -> Result<HookConfig, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    read_global_hook_config(&conn)
}

#[tauri::command]
pub async fn set_global_hook_config(
    state: State<'_, AppState>,
    config: HookConfig,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO global_worktree_hooks (id, copy_env_files, run_install_command, install_command, symlink_node_modules, custom_script_enabled, custom_script)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           copy_env_files = excluded.copy_env_files,
           run_install_command = excluded.run_install_command,
           install_command = excluded.install_command,
           symlink_node_modules = excluded.symlink_node_modules,
           custom_script_enabled = excluded.custom_script_enabled,
           custom_script = excluded.custom_script",
        params![
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

/// POSIX-shell (`/bin/sh`-compatible) hook script assembled from the
/// enabled presets + custom script — same syntax on every platform;
/// `hook_shell` below is what makes that syntax actually runnable on
/// Windows, rather than this script generation needing a second dialect.
fn build_hook_script(config: &HookConfig) -> String {
    let mut parts = Vec::new();
    if config.copy_env_files {
        // Recursively mirrors every `.env*` file from $SOURCE_WORKTREE into
        // the same relative path under $NEW_WORKTREE — not just the repo
        // root — so monorepos with per-package env files (e.g.
        // `apps/web/.env.local`) get them too. `find` output is captured
        // once via command substitution (rather than piped straight into
        // `while read`) so the "found none" branch doesn't need a second
        // `find` pass and doesn't lose state to the pipe subshell. Prune
        // list mirrors IGNORED_DIR_SEGMENTS in watcher.rs/fs_ops.rs.
        parts.push(
            r#"env_files=$(find "$SOURCE_WORKTREE" \( -name .git -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name coverage \) -prune -o -type f -name '.env*' -print 2>/dev/null)
if [ -z "$env_files" ]; then
  echo "No .env files found in $SOURCE_WORKTREE"
else
  echo "$env_files" | while IFS= read -r env_file; do
    rel_path=${env_file#"$SOURCE_WORKTREE"/}
    dest_path="$NEW_WORKTREE/$rel_path"
    mkdir -p "$(dirname "$dest_path")"
    cp "$env_file" "$dest_path"
  done
  echo "Copied .env files from $SOURCE_WORKTREE"
fi"#
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

/// Where to run `build_hook_script`'s POSIX-shell output.
#[cfg(unix)]
fn hook_shell() -> Result<std::path::PathBuf, String> {
    Ok(std::path::PathBuf::from("/bin/sh"))
}

/// Windows has no `/bin/sh` — but every Windows install this app runs on
/// already has `git.exe` on `PATH` (everything in `git.rs` depends on
/// that), and Git for Windows bundles a real MSYS2 `bash.exe` right next
/// to it. Reusing that avoids inventing a second, PowerShell-flavored
/// dialect of every hook preset (`cp`, `ln -s`, `[ -d ]`) just for one
/// platform — the same POSIX script that runs on macOS/Linux runs here
/// unmodified. This is the same "Git Bash" detection VS Code's integrated
/// terminal uses. The standard installer/winget/Chocolatey layout puts
/// `git.exe` two siblings away from `bash.exe`:
/// `<root>\cmd\git.exe` (the usual `PATH` entry) and `<root>\bin\git.exe`
/// both sit one level below `<root>`, with `<root>\bin\bash.exe` beside
/// them either way.
#[cfg(windows)]
fn hook_shell() -> Result<std::path::PathBuf, String> {
    let path = std::env::var_os("PATH").ok_or("PATH is not set")?;
    for dir in std::env::split_paths(&path) {
        if !dir.join("git.exe").is_file() {
            continue;
        }
        if let Some(root) = dir.parent() {
            let bash = root.join("bin").join("bash.exe");
            if bash.is_file() {
                return Ok(bash);
            }
        }
    }
    Err(
        "Worktree hooks need Git Bash, which ships with Git for Windows but \
         wasn't found next to git.exe on PATH. Reinstall Git for Windows \
         (gitforwindows.org) with its default components."
            .to_string(),
    )
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
        let config = resolve_effective_hook_config(&conn, &project_id)?;
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

    let shell = match hook_shell() {
        Ok(shell) => shell,
        Err(detail) => {
            let _ = app.emit(
                &channel,
                HookEvent::Line {
                    stream: "stderr",
                    text: detail,
                },
            );
            let _ = app.emit(
                &channel,
                HookEvent::Done {
                    exit_code: None,
                    success: false,
                    cancelled: false,
                    timed_out: false,
                },
            );
            return Ok(());
        }
    };

    let mut command = Command::new(&shell);
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
        .kill_on_drop(true)
        .hide_window();

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
        let mut runs = state.hook_runs.lock().map_err(|e| e.to_string())?;
        runs.insert(
            worktree_id.clone(),
            crate::state::HookRunEntry {
                cancel_tx,
                pid: child.id(),
                started_at_ms: crate::processes::now_ms(),
                worktree_path: worktree_path.clone(),
                branch: branch.clone(),
            },
        );
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
        let mut runs = state.hook_runs.lock().map_err(|e| e.to_string())?;
        runs.remove(&worktree_id);
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
    let entry = {
        let mut runs = state.hook_runs.lock().map_err(|e| e.to_string())?;
        runs.remove(&worktree_id)
    };
    if let Some(entry) = entry {
        let _ = entry.cancel_tx.send(());
    }
    Ok(())
}
