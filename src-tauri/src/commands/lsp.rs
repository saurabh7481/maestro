use crate::lsp::{
    self, LspControlMessage, LspProcessKey, LspServerKind, LspServerStatus, LspTransportEvent,
    RunningLspServer,
};
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

const GLOBAL_ENABLED_KEY: &str = "lsp.enabled";
const TYPESCRIPT_SDK_PATH_KEY: &str = "lsp.server.typescript.sdk_path";

fn binary_key(kind: LspServerKind) -> String {
    format!("lsp.server.{}.binary_path", kind.slug())
}

fn read_json_setting<T: serde::de::DeserializeOwned>(
    conn: &rusqlite::Connection,
    key: &str,
) -> Result<Option<T>, String> {
    conn.query_row(
        "SELECT value_json FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
    .transpose()
}

fn write_json_setting<T: Serialize>(
    conn: &rusqlite::Connection,
    key: &str,
    value: &T,
) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalLspSettings {
    pub enabled: bool,
}

impl Default for GlobalLspSettings {
    fn default() -> Self {
        Self { enabled: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLspSettings {
    pub enabled_override: Option<bool>,
    pub effective_enabled: bool,
}

fn global_settings(conn: &rusqlite::Connection) -> Result<GlobalLspSettings, String> {
    Ok(GlobalLspSettings {
        enabled: read_json_setting(conn, GLOBAL_ENABLED_KEY)?.unwrap_or(false),
    })
}

fn effective_enabled(conn: &rusqlite::Connection, project_id: &str) -> Result<bool, String> {
    let enabled_override = conn
        .query_row(
            "SELECT enabled_override FROM project_lsp_settings WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, Option<bool>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(enabled_override.unwrap_or(global_settings(conn)?.enabled))
}

#[tauri::command]
pub async fn get_global_lsp_settings(
    state: State<'_, AppState>,
) -> Result<GlobalLspSettings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    global_settings(&conn)
}

#[tauri::command]
pub async fn set_global_lsp_settings(
    state: State<'_, AppState>,
    settings: GlobalLspSettings,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    write_json_setting(&conn, GLOBAL_ENABLED_KEY, &settings.enabled)
}

#[tauri::command]
pub async fn get_project_lsp_settings(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectLspSettings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let enabled_override = conn
        .query_row(
            "SELECT enabled_override FROM project_lsp_settings WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, Option<bool>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let effective_enabled = effective_enabled(&conn, &project_id)?;
    Ok(ProjectLspSettings {
        enabled_override,
        effective_enabled,
    })
}

#[tauri::command]
pub async fn set_project_lsp_settings(
    state: State<'_, AppState>,
    project_id: String,
    enabled_override: Option<bool>,
) -> Result<ProjectLspSettings, String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_lsp_settings (project_id, enabled_override) VALUES (?1, ?2)
             ON CONFLICT(project_id) DO UPDATE SET enabled_override = excluded.enabled_override",
            params![project_id, enabled_override],
        )
        .map_err(|e| e.to_string())?;
    }
    get_project_lsp_settings(state, project_id).await
}

#[tauri::command]
pub async fn is_lsp_enabled_for_worktree(
    state: State<'_, AppState>,
    worktree_id: String,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let project_id = conn
        .query_row(
            "SELECT project_id FROM worktrees WHERE id = ?1",
            params![worktree_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Unknown worktree; refresh the project and try again.".to_string())?;
    effective_enabled(&conn, &project_id)
}

fn read_binary_override(
    conn: &rusqlite::Connection,
    kind: LspServerKind,
) -> Result<Option<String>, String> {
    read_json_setting(conn, &binary_key(kind))
}

#[tauri::command]
pub async fn detect_lsp_server(
    state: State<'_, AppState>,
    kind: LspServerKind,
    force: bool,
) -> Result<LspServerStatus, String> {
    if !force {
        if let Some(status) = state
            .lsp_status_cache
            .lock()
            .map_err(|e| e.to_string())?
            .get(&kind)
            .cloned()
        {
            return Ok(status);
        }
    }
    let binary_override = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        read_binary_override(&conn, kind)?
    };
    let status = lsp::detect(kind, binary_override).await;
    state
        .lsp_status_cache
        .lock()
        .map_err(|e| e.to_string())?
        .insert(kind, status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn detect_all_lsp_servers(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<LspServerStatus>, String> {
    let mut statuses = Vec::new();
    for kind in LspServerKind::all() {
        statuses.push(detect_lsp_server(state.clone(), kind, force).await?);
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn set_lsp_binary_path(
    state: State<'_, AppState>,
    kind: LspServerKind,
    path: Option<String>,
) -> Result<(), String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        match path.filter(|value| !value.trim().is_empty()) {
            Some(value) => write_json_setting(&conn, &binary_key(kind), &value)?,
            None => {
                conn.execute(
                    "DELETE FROM settings WHERE key = ?1",
                    params![binary_key(kind)],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    state
        .lsp_status_cache
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&kind);
    Ok(())
}

#[tauri::command]
pub async fn get_typescript_sdk_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    read_json_setting(&conn, TYPESCRIPT_SDK_PATH_KEY)
}

#[tauri::command]
pub async fn set_typescript_sdk_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match path.filter(|value| !value.trim().is_empty()) {
        Some(value) => write_json_setting(&conn, TYPESCRIPT_SDK_PATH_KEY, &value),
        None => conn
            .execute(
                "DELETE FROM settings WHERE key = ?1",
                params![TYPESCRIPT_SDK_PATH_KEY],
            )
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

fn validate_worktree(
    conn: &rusqlite::Connection,
    worktree_id: &str,
    requested_root: &Path,
) -> Result<(String, PathBuf), String> {
    let (project_id, stored_path): (String, String) = conn
        .query_row(
            "SELECT project_id, path FROM worktrees WHERE id = ?1",
            params![worktree_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Unknown worktree; refresh the project and try again.".to_string())?;
    let stored = PathBuf::from(stored_path);
    let stored_canonical = stored.canonicalize().map_err(|error| {
        format!(
            "Worktree path is unavailable ({}): {error}",
            stored.display()
        )
    })?;
    let requested_canonical = requested_root
        .canonicalize()
        .map_err(|error| format!("Requested worktree path is unavailable: {error}"))?;
    if stored_canonical != requested_canonical {
        return Err("Requested worktree root does not match the registered worktree.".to_string());
    }
    Ok((project_id, stored_canonical))
}

#[tauri::command]
pub async fn start_lsp_server(
    app: AppHandle,
    state: State<'_, AppState>,
    worktree_id: String,
    worktree_root: String,
    kind: LspServerKind,
    on_event: Channel<LspTransportEvent>,
) -> Result<RunningLspServer, String> {
    let key = LspProcessKey {
        worktree_id: worktree_id.clone(),
        kind,
    };
    if state
        .lsp_servers
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(&key)
    {
        return Err(format!(
            "{} is already running for this worktree.",
            kind.display_name()
        ));
    }

    let (root, binary_path, args, type_script_sdk_override) = {
        let conn = state.db.lock().map_err(|error| error.to_string())?;
        let (project_id, root) = validate_worktree(&conn, &worktree_id, Path::new(&worktree_root))?;
        if !effective_enabled(&conn, &project_id)? {
            return Err("Language intelligence is disabled for this project.".to_string());
        }
        let binary_path =
            read_binary_override(&conn, kind)?.unwrap_or_else(|| kind.default_binary().to_string());
        let args = kind
            .server_args()
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>();
        let type_script_sdk_override: Option<String> = if kind == LspServerKind::TypeScript {
            read_json_setting(&conn, TYPESCRIPT_SDK_PATH_KEY)?
        } else {
            None
        };
        (root, binary_path, args, type_script_sdk_override)
    };

    let type_script_sdk = if kind == LspServerKind::TypeScript {
        Some(lsp::resolve_typescript_sdk(
            &root,
            &binary_path,
            type_script_sdk_override.as_deref(),
        )?)
    } else {
        None
    };

    let entry = lsp::spawn_server(app, key.clone(), &root, &binary_path, &args, on_event).await?;
    let running = RunningLspServer {
        key: key.clone(),
        generation: entry.generation.clone(),
        pid: entry.pid,
        type_script_sdk,
    };
    Ok(running)
}

#[tauri::command]
pub async fn send_lsp_message(
    state: State<'_, AppState>,
    worktree_id: String,
    kind: LspServerKind,
    generation: String,
    message: String,
) -> Result<(), String> {
    lsp::validate_outbound_message(&message).map_err(|error| error.to_string())?;
    let key = LspProcessKey { worktree_id, kind };
    let sender = {
        let servers = state
            .lsp_servers
            .lock()
            .map_err(|error| error.to_string())?;
        let entry = servers.get(&key).ok_or("Language server is not running.")?;
        if entry.generation != generation {
            return Err(
                "Language server connection is stale; reconnect and try again.".to_string(),
            );
        }
        entry.control_tx.clone()
    };
    tokio::time::timeout(
        Duration::from_secs(2),
        sender.send(LspControlMessage::Send(message)),
    )
    .await
    .map_err(|_| "Language server write queue is full.".to_string())?
    .map_err(|_| "Language server stopped before the message was queued.".to_string())
}

#[tauri::command]
pub async fn stop_lsp_server(
    state: State<'_, AppState>,
    worktree_id: String,
    kind: LspServerKind,
    generation: Option<String>,
) -> Result<(), String> {
    let key = LspProcessKey { worktree_id, kind };
    let entry = {
        let mut servers = state
            .lsp_servers
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(entry) = servers.get(&key) else {
            return Ok(());
        };
        if generation
            .as_ref()
            .is_some_and(|value| value != &entry.generation)
        {
            return Ok(());
        }
        servers.remove(&key).expect("entry existed")
    };
    entry
        .control_tx
        .send(LspControlMessage::Stop)
        .await
        .map_err(|_| "Language server already stopped.".to_string())
}

#[tauri::command]
pub async fn list_running_lsp_servers(
    state: State<'_, AppState>,
) -> Result<Vec<RunningLspServer>, String> {
    let servers = state
        .lsp_servers
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(servers
        .iter()
        .map(|(key, entry)| RunningLspServer {
            key: key.clone(),
            generation: entry.generation.clone(),
            pid: entry.pid,
            type_script_sdk: None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_default_is_disabled() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);",
        )
        .unwrap();
        assert!(!global_settings(&conn).unwrap().enabled);
    }
}
