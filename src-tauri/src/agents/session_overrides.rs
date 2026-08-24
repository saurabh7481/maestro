//! Local-only metadata layered over CLI-native sessions: a title override
//! and a pin flag (`db.rs`'s `session_overrides` table). Maestro never
//! renames or reorders the CLI's own session files for this — a session's
//! *identity* stays whatever the CLI calls it; only how Maestro's own
//! resume list labels/orders it changes. `delete_resumable_session` is the
//! one command here that *does* touch the CLI's real file, since "delete"
//! has no local-only meaning the way rename/pin do.

use super::registry::AgentKind;
use super::sessions::resolve_session_file;
use crate::state::AppState;
use std::path::Path;
use tauri::State;

#[tauri::command]
pub async fn set_session_title(
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO session_overrides (session_id, title, pinned, updated_at)
         VALUES (?1, ?2, 0, ?3)
         ON CONFLICT(session_id) DO UPDATE SET
             title = excluded.title, updated_at = excluded.updated_at",
        rusqlite::params![session_id, title, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_session_pinned(
    state: State<'_, AppState>,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO session_overrides (session_id, title, pinned, updated_at)
         VALUES (?1, NULL, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET
             pinned = excluded.pinned, updated_at = excluded.updated_at",
        rusqlite::params![session_id, pinned as i64, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Applied to a freshly-listed batch of sessions in one query rather than
/// one lookup per session — `list_all_resumable_sessions` can return
/// hundreds of rows across every project.
pub fn apply_overrides(
    state: &AppState,
    sessions: &mut [super::sessions::ResumableSession],
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT session_id, title, pinned FROM session_overrides")
        .map_err(|e| e.to_string())?;
    let overrides: std::collections::HashMap<String, (Option<String>, bool)> = stmt
        .query_map([], |row| {
            let pinned: i64 = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, Option<String>>(1)?, pinned != 0),
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    for session in sessions.iter_mut() {
        if let Some((title, pinned)) = overrides.get(&session.session_id) {
            if let Some(title) = title {
                session.title = title.clone();
            }
            session.pinned = *pinned;
        }
    }
    Ok(())
}

/// Deletes the CLI's own on-disk session — real, permanent data loss the
/// frontend must confirm before calling this (`SessionManager.tsx`), not a
/// local-only edit like rename/pin. Unsupported for OpenCode/Aider (see
/// `resolve_session_file`'s doc comment); the frontend hides the action
/// for those kinds rather than surfacing this error, but it's still
/// checked here so a stale UI doesn't silently do nothing.
#[tauri::command]
pub async fn delete_resumable_session(
    state: State<'_, AppState>,
    kind: AgentKind,
    worktree_root: String,
    session_id: String,
) -> Result<(), String> {
    if matches!(kind, AgentKind::OpenCode | AgentKind::Aider) {
        return Err("Deleting sessions isn't supported for this CLI yet.".to_string());
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let path = resolve_session_file(Path::new(&home), kind, &worktree_root, &session_id)
        .await
        .ok_or_else(|| "Session file not found — it may already be gone.".to_string())?;

    if kind == AgentKind::CursorAgent {
        // One jsonl per session directory (`resolve_session_file`'s Cursor
        // branch) — remove the whole directory, not just the file, so no
        // empty shell is left behind under `agent-transcripts/`.
        if let Some(dir) = path.parent() {
            tokio::fs::remove_dir_all(dir)
                .await
                .map_err(|e| e.to_string())?;
        }
    } else {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Best-effort: a dangling override row for a session that no longer
    // exists is harmless clutter, not worth failing the delete over.
    if let Ok(conn) = state.db.lock() {
        let _ = conn.execute(
            "DELETE FROM session_overrides WHERE session_id = ?1",
            rusqlite::params![session_id],
        );
    }
    Ok(())
}
