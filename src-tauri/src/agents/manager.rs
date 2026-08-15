//! Shared agent-run lifecycle: spawning a turn, streaming its events,
//! session bookkeeping, interrupt/kill, and app-quit cleanup — all
//! CLI-agnostic. Only `adapter.rs` (and the per-CLI modules it dispatches
//! to) knows how to actually build a command or parse a line for a given
//! `AgentKind`; this module just drives that generically. Mirrors
//! `commands/hooks.rs::run_worktree_hook`'s spawn/stream/cancel shape.

use crate::agents::adapter::{self, PermissionMode, ToolUseCache, TurnCtx};
use crate::agents::events::AgentEvent;
use crate::agents::registry::AgentKind;
use crate::state::{AgentCancelKind, AgentRunEntry, AppState};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn agent_event_channel(run_id: &str) -> String {
    format!("agent://{run_id}/event")
}

/// Runs one turn: spawns a fresh CLI process (resuming the run's session
/// if one exists), feeds it the user's message (via stdin or argv,
/// whichever the adapter needs), streams parsed events out over
/// `agent://{run_id}/event`, and updates the run's `session_id`/
/// bookkeeping when the child exits.
async fn run_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    text: String,
) -> Result<(), String> {
    let (
        kind,
        binary_path,
        worktree_root,
        resume_session_id,
        allowed_tools,
        fork_session,
        model,
        permission_mode,
    ) = {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        let entry = runs.get_mut(&run_id).ok_or("no such agent run")?;
        let fork_session = entry.pending_fork;
        entry.pending_fork = false;
        (
            entry.kind,
            entry.kind.default_binary().to_string(),
            entry.worktree_root.clone(),
            entry.session_id.clone(),
            entry.allowed_tools.clone(),
            fork_session,
            entry.model.clone(),
            entry.permission_mode,
        )
    };

    let ctx = TurnCtx {
        binary_path: &binary_path,
        worktree_root: &worktree_root,
        resume_session_id: resume_session_id.as_deref(),
        fork_session,
        allowed_tools: &allowed_tools,
        model: model.as_deref(),
        permission_mode,
    };
    let spawn = adapter::build_turn(kind, &ctx, &text);
    let mut command = spawn.command;

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", kind.display_name()))?;

    if let Some(payload) = spawn.stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            // Dropping closes the write half — signals EOF.
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture {} stdout", kind.display_name()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture {} stderr", kind.display_name()))?;
    let channel = agent_event_channel(&run_id);

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    let stdout_task = tokio::spawn(async move {
        let mut tool_use_cache: ToolUseCache = ToolUseCache::new();
        let mut learned_session_id = None;
        let mut lines = BufReader::new(stdout).lines();
        // Not strictly one-JSON-object-per-line in practice: observed
        // live that `cursor-agent` can emit a `call_id` containing a raw
        // (unescaped) newline byte — invalid per the JSON string grammar,
        // but real captured output does it — splitting one JSON object
        // across two physical lines. Buffer and retry rather than
        // assuming a parse failure means a genuinely malformed line;
        // rejoin with an *escaped* `\n` (two chars), not a raw newline
        // byte, since a raw one would just reconstruct the same invalid
        // control-character-in-a-string that broke the line in the first
        // place. Bounded so a truly malformed line still surfaces as an
        // error instead of buffering forever.
        let mut buffer = String::new();
        let mut buffered_segments = 0u32;
        while let Ok(Some(raw_line)) = lines.next_line().await {
            if raw_line.trim().is_empty() && buffer.is_empty() {
                continue;
            }
            if !buffer.is_empty() {
                buffer.push_str("\\n");
            }
            buffer.push_str(&raw_line);
            buffered_segments += 1;

            let looks_complete = serde_json::from_str::<serde_json::Value>(&buffer).is_ok();
            if !looks_complete && buffered_segments < 4 {
                continue;
            }

            let line = std::mem::take(&mut buffer);
            buffered_segments = 0;
            let (events, session_id) = adapter::parse_line(kind, &line, &mut tool_use_cache);
            if session_id.is_some() {
                learned_session_id = session_id;
            }
            for event in events {
                let _ = stdout_app.emit(&stdout_channel, &event);
            }
        }
        learned_session_id
    });

    let stderr_app = app.clone();
    let stderr_channel = channel.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let _ = stderr_app.emit(&stderr_channel, &AgentEvent::Error { message: line });
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = runs.get_mut(&run_id) {
            entry.cancel_tx = Some(cancel_tx);
        }
    }

    let exit_code = tokio::select! {
        status = child.wait() => status.ok().and_then(|s| s.code()),
        cancel = &mut cancel_rx => {
            match cancel {
                Ok(AgentCancelKind::Soft) => {
                    #[cfg(unix)]
                    if let Some(pid) = child.id() {
                        let _ = nix::sys::signal::kill(
                            nix::unistd::Pid::from_raw(pid as i32),
                            nix::sys::signal::Signal::SIGINT,
                        );
                        let grace = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                        if grace.is_err() {
                            let _ = child.kill().await;
                        }
                    }
                    #[cfg(not(unix))]
                    { let _ = child.kill().await; }
                    None
                }
                _ => {
                    let _ = child.kill().await;
                    None
                }
            }
        }
    };

    let learned_session_id = stdout_task.await.unwrap_or(None);
    {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = runs.get_mut(&run_id) {
            entry.cancel_tx = None;
            if learned_session_id.is_some() {
                entry.session_id = learned_session_id;
            }
        }
    }
    let _ = app.emit(&channel, &AgentEvent::Exit { code: exit_code });
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentSessionRequest {
    pub run_id: String,
    pub worktree_id: String,
    pub worktree_root: String,
    pub kind: AgentKind,
    pub resume_session_id: Option<String>,
    pub fork_session: bool,
    pub first_message: String,
    /// `--model` id/alias, or `None` for the CLI's own default. Only
    /// Claude and Cursor Agent expose a real one; ignored for Codex.
    pub model: Option<String>,
}

#[tauri::command]
pub async fn start_agent_session(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartAgentSessionRequest,
) -> Result<(), String> {
    let StartAgentSessionRequest {
        run_id,
        worktree_id,
        worktree_root,
        kind,
        resume_session_id,
        fork_session,
        first_message,
        model,
    } = request;
    {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        runs.insert(
            run_id.clone(),
            AgentRunEntry {
                kind,
                worktree_id,
                worktree_root,
                session_id: resume_session_id,
                model,
                pending_fork: fork_session,
                allowed_tools: crate::agents::claude::DEFAULT_ALLOWED_TOOLS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                permission_mode: PermissionMode::default(),
                cancel_tx: None,
            },
        );
    }
    run_turn(app, state, run_id, first_message).await
}

/// Switches a tab's run to a different (already-existing) CLI session,
/// for the "resume a past session into this tab" flow (paired with
/// `sessions::get_session_transcript` on the frontend for hydrating the
/// visible transcript). Wholesale-replaces any existing run entry — a
/// resumed session is a genuinely different conversation, so prior
/// in-memory state like accumulated `allowed_tools`/`bypass_permissions`
/// from whatever this tab was doing before shouldn't carry over. If no
/// entry existed yet (a fresh, never-started tab), this creates one, so
/// the next composer submit's `send_agent_message` finds a run to attach
/// to instead of erroring on "no such agent run".
#[tauri::command]
pub async fn resume_agent_session(
    state: State<'_, AppState>,
    run_id: String,
    worktree_id: String,
    worktree_root: String,
    kind: AgentKind,
    session_id: String,
) -> Result<(), String> {
    let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
    runs.insert(
        run_id,
        AgentRunEntry {
            kind,
            worktree_id,
            worktree_root,
            session_id: Some(session_id),
            model: None,
            pending_fork: false,
            allowed_tools: crate::agents::claude::DEFAULT_ALLOWED_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            permission_mode: PermissionMode::default(),
            cancel_tx: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn send_agent_message(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    text: String,
) -> Result<(), String> {
    run_turn(app, state, run_id, text).await
}

/// There's no one-time-only approval available for any of the three CLIs
/// (see each adapter's module doc) — any "Approve" widens the run's
/// trust for the rest of the tab's lifetime: for Claude that means
/// adding the tool to `allowed_tools`; for Cursor/Codex, which have no
/// per-invocation allow-list, it means turning on `bypass_permissions`
/// (equivalent to `--force`/`--yolo`) for the rest of the tab. This is
/// why the UI presents a single "Approve" action rather than separate
/// "once"/"always" buttons.
// See `git.rs::DiffContent`'s comment — the same gotcha applies to
// Deserialize too: enum-level `rename_all` doesn't cascade into a
// struct-like variant's fields, so without the variant-level attribute
// below, the frontend's `toolName` would fail to deserialize into
// `tool_name` here.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "decision")]
pub enum PermissionDecision {
    #[serde(rename_all = "camelCase")]
    Approve {
        tool_name: String,
    },
    Deny,
}

#[tauri::command]
pub async fn respond_to_permission(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    let nudge = match &decision {
        PermissionDecision::Approve { tool_name } => {
            let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
            if let Some(entry) = runs.get_mut(&run_id) {
                match entry.kind {
                    AgentKind::ClaudeCode => {
                        if !entry.allowed_tools.iter().any(|t| t == tool_name) {
                            entry.allowed_tools.push(tool_name.clone());
                        }
                    }
                    AgentKind::CursorAgent | AgentKind::Codex => {
                        entry.permission_mode = PermissionMode::Auto;
                    }
                }
            }
            format!("Permission granted for the {tool_name} action you just attempted — please proceed with it now.")
        }
        PermissionDecision::Deny => {
            "Permission denied for that action. Please continue without it, or suggest an alternative approach.".to_string()
        }
    };
    run_turn(app, state, run_id, nudge).await
}

/// Explicit, off-by-default-to-`Manual` opt-in (docs/CHECKLIST.md) —
/// takes effect on the *next* turn, not retroactively.
#[tauri::command]
pub async fn set_permission_mode(
    state: State<'_, AppState>,
    run_id: String,
    mode: PermissionMode,
) -> Result<(), String> {
    let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = runs.get_mut(&run_id) {
        entry.permission_mode = mode;
    }
    Ok(())
}

#[tauri::command]
pub async fn interrupt_agent(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let sender = {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        runs.get_mut(&run_id).and_then(|e| e.cancel_tx.take())
    };
    if let Some(tx) = sender {
        let _ = tx.send(AgentCancelKind::Soft);
    }
    Ok(())
}

#[tauri::command]
pub async fn kill_agent(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let sender = {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        runs.get_mut(&run_id).and_then(|e| e.cancel_tx.take())
    };
    if let Some(tx) = sender {
        let _ = tx.send(AgentCancelKind::Hard);
    }
    {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        runs.remove(&run_id);
    }
    Ok(())
}

/// Kills every live run for a worktree — called when the worktree is
/// about to be removed (docs/CHECKLIST.md: "worktree removal tears down
/// running agent tabs first, not left dangling"). Returns the run ids it
/// killed so the frontend can also drop those tabs.
#[tauri::command]
pub async fn kill_agent_runs_for_worktree(
    state: State<'_, AppState>,
    worktree_id: String,
) -> Result<Vec<String>, String> {
    let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
    let ids: Vec<String> = runs
        .iter()
        .filter(|(_, entry)| entry.worktree_id == worktree_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        if let Some(entry) = runs.get_mut(id) {
            if let Some(tx) = entry.cancel_tx.take() {
                let _ = tx.send(AgentCancelKind::Hard);
            }
        }
    }
    runs.retain(|_, entry| entry.worktree_id != worktree_id);
    Ok(ids)
}

/// Kills every live agent turn — called from `lib.rs`'s `ExitRequested`
/// handler alongside `terminal::kill_all` so quitting doesn't orphan
/// child processes (docs/CHECKLIST.md). Sync (no `.await`): this runs
/// from a plain `FnMut` `RunEvent` callback, not an async context —
/// `oneshot::Sender::send` doesn't need one.
pub fn kill_all(state: &AppState) {
    let mut runs = match state.agent_runs.lock() {
        Ok(r) => r,
        Err(_) => return,
    };
    for (_, mut entry) in runs.drain() {
        if let Some(tx) = entry.cancel_tx.take() {
            let _ = tx.send(AgentCancelKind::Hard);
        }
    }
}
