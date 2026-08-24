//! Worktree location settings — where `create_worktree` puts new
//! worktrees. Global default + per-project override, the same
//! inherit-or-replace pattern as the hooks config in `commands/hooks.rs`
//! (including the split global/project tables — see `db.rs`'s comment for
//! why the global row lives in its own table).

use crate::models::WorktreeSettings;
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};
use tauri::State;

fn read_project_settings(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<WorktreeSettings, String> {
    conn.query_row(
        "SELECT worktree_dir, override_enabled FROM project_worktree_settings WHERE project_id = ?1",
        params![project_id],
        |row| {
            Ok(WorktreeSettings {
                worktree_dir: row.get(0)?,
                override_enabled: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|s| s.unwrap_or_default())
}

/// The global default location. Its own `override_enabled` is meaningless
/// (always `false`): the global setting has nothing to override.
fn read_global_settings(conn: &rusqlite::Connection) -> Result<WorktreeSettings, String> {
    conn.query_row(
        "SELECT worktree_dir FROM global_worktree_settings WHERE id = 1",
        [],
        |row| {
            Ok(WorktreeSettings {
                worktree_dir: row.get(0)?,
                override_enabled: false,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|s| s.unwrap_or_default())
}

/// The location that actually governs a project's new worktrees: its own,
/// if it opted in via `override_enabled`, otherwise the global default.
/// Empty string = auto (the caller decides what that means — see
/// `worktree_path_for`).
pub fn resolve_effective_worktree_dir(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<String, String> {
    let project_settings = read_project_settings(conn, project_id)?;
    if project_settings.override_enabled {
        Ok(project_settings.worktree_dir)
    } else {
        Ok(read_global_settings(conn)?.worktree_dir)
    }
}

/// `~/…` expands to the user's home directory — `PathBuf` does no such
/// thing on its own, and a literal `~` directory is a nasty surprise to
/// discover only after a worktree was created inside it.
fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = home_dir() {
            return PathBuf::from(home);
        }
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

/// The full path for a new worktree: the resolved base location plus the
/// branch name (which may contain `/` — those become nested directories,
/// exactly as the historical auto layout allowed).
///
/// Empty base = auto: a sibling `<repo>.worktrees` directory next to the
/// repo. A relative base resolves against the repo's parent too, so
/// `maestro-wt` and the auto layout land in the same neighbourhood.
pub fn worktree_path_for(repo_dir: &Path, base_dir: &str, branch_name: &str) -> PathBuf {
    let base = base_dir.trim();
    let parent = repo_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| repo_dir.to_path_buf());
    if base.is_empty() {
        let repo_name = repo_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string());
        return parent
            .join(format!("{repo_name}.worktrees"))
            .join(branch_name);
    }
    let resolved = expand_tilde(base);
    if resolved.is_absolute() {
        resolved.join(branch_name)
    } else {
        parent.join(resolved).join(branch_name)
    }
}

#[tauri::command]
pub async fn get_worktree_settings(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<WorktreeSettings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    read_project_settings(&conn, &project_id)
}

#[tauri::command]
pub async fn set_worktree_settings(
    state: State<'_, AppState>,
    project_id: String,
    settings: WorktreeSettings,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO project_worktree_settings (project_id, worktree_dir, override_enabled)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(project_id) DO UPDATE SET
           worktree_dir = excluded.worktree_dir,
           override_enabled = excluded.override_enabled",
        params![project_id, settings.worktree_dir, settings.override_enabled],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_global_worktree_settings(
    state: State<'_, AppState>,
) -> Result<WorktreeSettings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    read_global_settings(&conn)
}

#[tauri::command]
pub async fn set_global_worktree_settings(
    state: State<'_, AppState>,
    settings: WorktreeSettings,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO global_worktree_settings (id, worktree_dir) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET worktree_dir = excluded.worktree_dir",
        params![settings.worktree_dir],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE project_worktree_settings (
                 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                 worktree_dir TEXT NOT NULL DEFAULT '',
                 override_enabled INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE global_worktree_settings (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 worktree_dir TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();
        conn.execute("INSERT INTO projects (id) VALUES ('p1')", [])
            .unwrap();
        conn
    }

    #[test]
    fn empty_everything_resolves_to_auto() {
        let conn = memory_db();
        assert_eq!(resolve_effective_worktree_dir(&conn, "p1").unwrap(), "");
    }

    #[test]
    fn project_override_beats_global() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO global_worktree_settings (id, worktree_dir) VALUES (1, '/srv/wt')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_worktree_settings (project_id, worktree_dir, override_enabled) VALUES ('p1', '/tmp/only-this', 1)",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_effective_worktree_dir(&conn, "p1").unwrap(),
            "/tmp/only-this"
        );
    }

    #[test]
    fn override_switch_off_inherits_global_even_with_a_staged_path() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO global_worktree_settings (id, worktree_dir) VALUES (1, '/srv/wt')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_worktree_settings (project_id, worktree_dir, override_enabled) VALUES ('p1', '/tmp/only-this', 0)",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_effective_worktree_dir(&conn, "p1").unwrap(),
            "/srv/wt"
        );
    }

    #[test]
    fn auto_layout_is_a_sibling_worktrees_directory() {
        let path = worktree_path_for(Path::new("/home/u/Code/repo"), "", "feat/x");
        assert_eq!(
            path,
            PathBuf::from("/home/u/Code/repo.worktrees").join("feat/x")
        );
    }

    #[test]
    fn absolute_base_is_used_as_is() {
        let path = worktree_path_for(Path::new("/home/u/Code/repo"), "/srv/wt", "b");
        assert_eq!(path, PathBuf::from("/srv/wt/b"));
    }

    #[test]
    fn relative_base_resolves_against_the_repo_parent() {
        let path = worktree_path_for(Path::new("/home/u/Code/repo"), "wt", "b");
        assert_eq!(path, PathBuf::from("/home/u/Code/wt/b"));
    }

    #[cfg(unix)]
    #[test]
    fn tilde_expands_to_home() {
        std::env::set_var("HOME", "/home/u");
        let path = worktree_path_for(Path::new("/home/u/Code/repo"), "~/wt", "b");
        assert_eq!(path, PathBuf::from("/home/u/wt/b"));
    }
}
