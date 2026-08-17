//! Durable storage for an agent tab's rendered conversation.
//!
//! ## Why this exists rather than replaying the CLI's own session
//!
//! Every wrapped CLI keeps its own session history, and `sessions.rs` can
//! already replay one — but only as `TranscriptTurn`s, which are text
//! only. Restoring a tab that way silently drops every tool call, diff,
//! thinking block and permission decision the conversation actually
//! contained. Since the app kills its child processes on quit
//! (docs/CHECKLIST.md), a restored agent tab used to come back completely
//! empty, which reads as data loss rather than as a restart.
//!
//! So the frontend's own `TranscriptItem[]` is what gets stored. Rust
//! deliberately never interprets it: the payload is an opaque JSON string
//! plus a `version`, and a payload whose version this build doesn't know
//! is discarded on load rather than half-parsed into something broken.
//!
//! Continuity of the *conversation* (as opposed to its rendering) still
//! comes from the CLI: `cli_session_id` is stored alongside so the
//! frontend can call `resume_agent_session` and have the next message
//! continue the same session rather than start a new one.

use crate::state::AppState;
use rusqlite::OptionalExtension;
use tauri::State;

/// Bumped when `TranscriptItem`'s shape changes incompatibly. Older rows
/// are then ignored (and overwritten on the next save) instead of being
/// fed to a renderer that can't read them.
pub const TRANSCRIPT_VERSION: i64 = 1;

/// Guards against one runaway conversation bloating the database. Well
/// past any transcript a person will read back through, and the frontend
/// trims tool output before it ever gets here.
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTranscript {
    pub items: String,
    pub cli_session_id: Option<String>,
}

#[tauri::command]
pub async fn save_agent_transcript(
    state: State<'_, AppState>,
    run_id: String,
    worktree_id: String,
    agent: String,
    cli_session_id: Option<String>,
    items: String,
) -> Result<(), String> {
    if items.len() > MAX_PAYLOAD_BYTES {
        // Not an error the user can act on, and losing the *persisted*
        // copy is far better than failing the turn that triggered the
        // save — the live transcript is unaffected either way.
        return Ok(());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO agent_transcripts
             (run_id, worktree_id, agent, cli_session_id, version, items, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(run_id) DO UPDATE SET
             worktree_id    = excluded.worktree_id,
             agent          = excluded.agent,
             cli_session_id = excluded.cli_session_id,
             version        = excluded.version,
             items          = excluded.items,
             updated_at     = excluded.updated_at",
        rusqlite::params![
            run_id,
            worktree_id,
            agent,
            cli_session_id,
            TRANSCRIPT_VERSION,
            items,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_agent_transcript(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Option<StoredTranscript>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT items, cli_session_id FROM agent_transcripts
             WHERE run_id = ?1 AND version = ?2",
            rusqlite::params![run_id, TRANSCRIPT_VERSION],
            |row| {
                Ok(StoredTranscript {
                    items: row.get(0)?,
                    cli_session_id: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_agent_transcript(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM agent_transcripts WHERE run_id = ?1",
        rusqlite::params![run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drops transcripts for tabs that no longer exist. Closing a tab already
/// deletes its row, but a crash or a session file that failed to restore
/// would otherwise leave rows behind forever — this is the sweep that
/// keeps the table bounded by "tabs the user actually has".
#[tauri::command]
pub async fn prune_agent_transcripts(
    state: State<'_, AppState>,
    keep_run_ids: Vec<String>,
) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if keep_run_ids.is_empty() {
        return conn
            .execute("DELETE FROM agent_transcripts", [])
            .map_err(|e| e.to_string());
    }
    // Built rather than bound as one parameter because SQLite has no array
    // binding; the ids are app-generated tab ids, and they still go through
    // `params_from_iter` as real bound values rather than being formatted
    // into the SQL.
    let placeholders = std::iter::repeat_n("?", keep_run_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    conn.execute(
        &format!("DELETE FROM agent_transcripts WHERE run_id NOT IN ({placeholders})"),
        rusqlite::params_from_iter(keep_run_ids.iter()),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_transcripts (
                run_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, agent TEXT NOT NULL,
                cli_session_id TEXT, version INTEGER NOT NULL, items TEXT NOT NULL,
                updated_at TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn save(conn: &rusqlite::Connection, run_id: &str, items: &str, version: i64) {
        conn.execute(
            "INSERT INTO agent_transcripts VALUES (?1,'w','claudeCode','sess',?2,?3,'now')
             ON CONFLICT(run_id) DO UPDATE SET items = excluded.items",
            rusqlite::params![run_id, version, items],
        )
        .unwrap();
    }

    fn load(conn: &rusqlite::Connection, run_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT items FROM agent_transcripts WHERE run_id = ?1 AND version = ?2",
            rusqlite::params![run_id, TRANSCRIPT_VERSION],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn a_transcript_round_trips() {
        let conn = memory_db();
        save(&conn, "tab-1", r#"[{"kind":"user"}]"#, TRANSCRIPT_VERSION);
        assert_eq!(
            load(&conn, "tab-1").as_deref(),
            Some(r#"[{"kind":"user"}]"#)
        );
    }

    #[test]
    fn saving_twice_replaces_rather_than_duplicating() {
        let conn = memory_db();
        save(&conn, "tab-1", "[1]", TRANSCRIPT_VERSION);
        save(&conn, "tab-1", "[1,2]", TRANSCRIPT_VERSION);
        assert_eq!(load(&conn, "tab-1").as_deref(), Some("[1,2]"));
    }

    #[test]
    fn a_transcript_from_an_older_shape_is_ignored_not_returned() {
        let conn = memory_db();
        save(&conn, "tab-1", "[999]", TRANSCRIPT_VERSION - 1);
        // Half-reading an incompatible payload is how a restore turns into
        // a crash; skipping it just means the tab starts empty.
        assert_eq!(load(&conn, "tab-1"), None);
    }
}
