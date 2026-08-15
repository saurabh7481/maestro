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
            custom_script         TEXT NOT NULL DEFAULT '',
            override_enabled      INTEGER NOT NULL DEFAULT 0
        );

        -- Single-row (id is always 1) default hook config applied to every
        -- project that doesn't have `worktree_hooks.override_enabled` set —
        -- see `commands/hooks.rs::run_worktree_hook`. A separate table
        -- rather than a `project_id`-nullable row in `worktree_hooks`,
        -- since that column has an `ON DELETE CASCADE` FK to `projects`
        -- that a sentinel/global row has no project to reference.
        CREATE TABLE IF NOT EXISTS global_worktree_hooks (
            id                    INTEGER PRIMARY KEY CHECK (id = 1),
            copy_env_files        INTEGER NOT NULL DEFAULT 1,
            run_install_command   INTEGER NOT NULL DEFAULT 1,
            install_command       TEXT,
            symlink_node_modules  INTEGER NOT NULL DEFAULT 0,
            custom_script_enabled INTEGER NOT NULL DEFAULT 0,
            custom_script         TEXT NOT NULL DEFAULT ''
        );

        -- Free-form key/value settings — currently just per-CLI binary
        -- path overrides (`agent.<slug>.binary_path`), see
        -- docs/ARCHITECTURE.md §4.
        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );

        -- A nullable tri-state project override for Language Server support:
        -- NULL inherits the global `lsp.enabled` setting, 0 disables, and 1
        -- enables. Keeping this separate from the free-form settings table
        -- gives project deletion proper FK cleanup and makes precedence
        -- impossible to interpret differently in separate callers.
        CREATE TABLE IF NOT EXISTS project_lsp_settings (
            project_id       TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            enabled_override INTEGER CHECK (enabled_override IN (0, 1) OR enabled_override IS NULL)
        );

        -- Index/cache only, never the source of truth: each CLI persists
        -- its own session history on disk (see agents/sessions.rs). This
        -- table exists for pid/start-time bookkeeping (future zombie-reap
        -- work, see docs/CHECKLIST.md's edge-case sweep) and a fast
        -- per-worktree 'last used agent' lookup. Reconciled against the
        -- CLI's own session directory at list-time, not trusted alone.
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id             TEXT PRIMARY KEY,
            worktree_id    TEXT NOT NULL,
            agent          TEXT NOT NULL,
            cli_session_id TEXT,
            pid            INTEGER,
            started_at     TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            title          TEXT
        );
        ",
    )?;

    // Additive migration: `worktree_hooks` predates the global/project-level
    // hooks split (`commands/hooks.rs`) — existing installs' rows won't have
    // this column yet. SQLite has no `ADD COLUMN IF NOT EXISTS`, so this
    // just swallows the "duplicate column name" error every boot after the
    // first one runs it.
    let _ = conn.execute(
        "ALTER TABLE worktree_hooks ADD COLUMN override_enabled INTEGER NOT NULL DEFAULT 0",
        [],
    );

    Ok(())
}
