use rusqlite::Connection;
use std::path::Path;

pub fn open(app_data_dir: &Path) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_data_dir).ok();
    let conn = Connection::open(app_data_dir.join("maestro.sqlite"))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            root_path  TEXT NOT NULL UNIQUE,
            added_at   TEXT NOT NULL
        );

        -- Reconciled cache, not the source of truth: `git worktree list`
        -- is authoritative. This table exists to give each worktree a
        -- stable id (for later phases' agent-session linking) and to
        -- track last_opened_at; path/branch/etc. are overwritten on every
        -- reconcile pass, and rows for worktrees git no longer reports
        -- are deleted. See docs/ARCHITECTURE.md §4.
        CREATE TABLE IF NOT EXISTS worktrees (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            path            TEXT NOT NULL,
            branch          TEXT NOT NULL,
            is_primary      INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            last_opened_at  TEXT,
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS worktree_hooks (
            project_id            TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            copy_env_files        INTEGER NOT NULL DEFAULT 1,
            run_install_command   INTEGER NOT NULL DEFAULT 1,
            install_command       TEXT,
            symlink_node_modules  INTEGER NOT NULL DEFAULT 0,
            custom_script_enabled INTEGER NOT NULL DEFAULT 0,
            custom_script         TEXT NOT NULL DEFAULT ''
        );
        ",
    )
}
