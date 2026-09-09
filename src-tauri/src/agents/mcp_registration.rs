//! Registers Maestro's local MCP tool server (`agents/mcp_tools.rs`) with
//! Cursor Agent, the one wrapped CLI that has no per-invocation way to point
//! at an MCP server — unlike Claude Code (`--mcp-config`, ephemeral, see
//! `claude.rs::build_turn`) and Codex (`-c mcp_servers.maestro.url=...`,
//! also ephemeral and confirmed live against a real `codex mcp list` — see
//! `codex.rs::build_turn`), Cursor only reads MCP servers from
//! `~/.cursor/mcp.json` (confirmed against this machine's real file).
//!
//! This merges a single `"maestro"` key into that file — every other server
//! the user has configured there is read back and rewritten byte-for-byte
//! equivalent (as JSON; `serde_json` doesn't preserve exact formatting, but
//! preserves every other key/value) — and removes it again if the user
//! turns the feature off. Runs once per app launch (the port is ephemeral,
//! so it changes every restart) plus whenever `set_mcp_tools_enabled`
//! toggles the setting.

use crate::commands::agents::mcp_tools_enabled;
use crate::state::AppState;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CURSOR_SERVER_NAME: &str = "maestro";

fn cursor_mcp_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".cursor").join("mcp.json"))
}

/// Adds or removes the `maestro` entry in `~/.cursor/mcp.json` to match the
/// current setting (`commands::agents::mcp_tools_enabled`). `port` is
/// `None` only if the local MCP server itself failed to start, in which
/// case there is nothing to point Cursor at and any existing registration
/// is left alone rather than half-updated.
pub async fn sync(app: &AppHandle, port: Option<u16>) {
    let enabled = {
        let state = app.state::<AppState>();
        let Ok(conn) = state.db.lock() else {
            return;
        };
        mcp_tools_enabled(&conn).unwrap_or(true)
    };

    let result = if enabled {
        match port {
            Some(port) => register(port),
            None => Ok(()),
        }
    } else {
        deregister()
    };

    if let Err(error) = result {
        log::warn!("Could not update Cursor Agent's MCP registration for Maestro: {error}");
    }
}

fn register(port: u16) -> Result<(), String> {
    let Some(path) = cursor_mcp_path() else {
        return Err("could not resolve the home directory".to_string());
    };
    let mut root = read_json_object(&path)?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| format!("{}'s \"mcpServers\" is not an object", path.display()))?;
    servers.insert(
        CURSOR_SERVER_NAME.to_string(),
        serde_json::json!({ "url": format!("http://127.0.0.1:{port}/mcp") }),
    );
    write_json_atomic(&path, &root)
}

fn deregister() -> Result<(), String> {
    let Some(path) = cursor_mcp_path() else {
        return Err("could not resolve the home directory".to_string());
    };
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object(&path)?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .map(|servers| servers.remove(CURSOR_SERVER_NAME).is_some())
        .unwrap_or(false);
    if removed {
        write_json_atomic(&path, &root)?;
    }
    Ok(())
}

/// An empty map for a missing or empty file — same "nothing configured
/// yet" starting point `~/.cursor/mcp.json` would have before Cursor or the
/// user ever wrote to it.
fn read_json_object(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| e.to_string())?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} does not contain a JSON object", path.display()))
}

fn write_json_atomic(
    path: &Path,
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(object).map_err(|e| e.to_string())?;
    let mut file = atomic_write_file::AtomicWriteFile::open(path).map_err(|e| e.to_string())?;
    file.write_all(pretty.as_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"\n").map_err(|e| e.to_string())?;
    file.commit().map_err(|e| e.to_string())
}
