//! Desktop-side device management — the Tauri commands behind the
//! "Connected Devices" Settings pane: list every paired device (with live
//! online/offline from `RelayState`), revoke one, and flip its access
//! level between write and read-only. All plain CRUD over the
//! `paired_devices` table (`db.rs`); the relay's own `auth.rs` is what
//! actually enforces `revoked_at`/`access_level` on incoming requests —
//! these commands only edit the row it reads.

use tauri::State;

use crate::state::AppState;

use super::RelayState;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub access_level: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
    pub online: bool,
}

#[tauri::command]
pub async fn list_paired_devices(
    state: State<'_, AppState>,
    relay: State<'_, RelayState>,
) -> Result<Vec<PairedDevice>, String> {
    struct Row {
        id: String,
        name: String,
        access_level: String,
        created_at: String,
        last_seen_at: Option<String>,
        revoked_at: Option<String>,
    }
    let rows: Vec<Row> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, access_level, created_at, last_seen_at, revoked_at
                 FROM paired_devices ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([], |row| {
                Ok(Row {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    access_level: row.get(2)?,
                    created_at: row.get(3)?,
                    last_seen_at: row.get(4)?,
                    revoked_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        collected
    };
    Ok(rows
        .into_iter()
        .map(|row| PairedDevice {
            online: row.revoked_at.is_none() && relay.is_connected(&row.id),
            id: row.id,
            name: row.name,
            access_level: row.access_level,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
            revoked_at: row.revoked_at,
        })
        .collect())
}

#[tauri::command]
pub async fn revoke_device(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE paired_devices SET revoked_at = ?1 WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), device_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Permanently forgets a device — unlike `revoke_device`, which only
/// blocks its existing token, this removes the row from the list
/// entirely. Restricted to already-revoked devices at the call site
/// (`ConnectedDevicesPane.tsx`) rather than here: deleting a still-active
/// pairing would silently drop the one record `auth.rs` checks `revoked_at`
/// against, effectively un-revoking nothing and un-tracking a device that
/// can still authenticate.
#[tauri::command]
pub async fn delete_device(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM paired_devices WHERE id = ?1",
        rusqlite::params![device_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_device_access(
    state: State<'_, AppState>,
    device_id: String,
    access_level: String,
) -> Result<(), String> {
    if access_level != "write" && access_level != "read" {
        return Err("access_level must be 'write' or 'read'".to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE paired_devices SET access_level = ?1 WHERE id = ?2",
        rusqlite::params![access_level, device_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_device(
    state: State<'_, AppState>,
    device_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE paired_devices SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, device_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
