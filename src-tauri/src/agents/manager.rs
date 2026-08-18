//! Shared agent-run lifecycle: spawning a turn, streaming its events,
//! session bookkeeping, interrupt/kill, and app-quit cleanup — all
//! CLI-agnostic. Only `adapter.rs` (and the per-CLI modules it dispatches
//! to) knows how to actually build a command or parse a line for a given
//! `AgentKind`; this module just drives that generically. Mirrors
//! `commands/hooks.rs::run_worktree_hook`'s spawn/stream/cancel shape.

use crate::agents::adapter::{self, PermissionMode, ToolUseCache, TurnCtx};
use crate::agents::capabilities::Streaming;
use crate::agents::events::AgentEvent;
use crate::agents::registry::AgentKind;
use crate::state::{AgentCancelKind, AgentRunEntry, AppState};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn agent_event_channel(run_id: &str) -> String {
    format!("agent://{run_id}/event")
}

/// How long streamed text is allowed to pool before being sent to the UI.
/// Roughly a few display frames: fast enough to read as typing, slow
/// enough that a long response costs tens of updates rather than
/// thousands.
const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(60);

/// Emits whatever streamed text has pooled, if any, and clears the buffer.
/// Must be called before emitting any non-delta event so the transcript
/// keeps the order the model produced things in.
fn flush_delta(app: &AppHandle, channel: &str, pending: &mut String) {
    if pending.is_empty() {
        return;
    }
    let _ = app.emit(
        channel,
        &AgentEvent::MessageDelta {
            text: std::mem::take(pending),
        },
    );
}

/// Releases a run's "a turn is in flight" latch on a path that gives up
/// before the normal end-of-turn bookkeeping runs. Without this an early
/// return would leave the run permanently refusing new turns.
fn clear_turn_active(state: &State<'_, AppState>, run_id: &str) {
    if let Ok(mut runs) = state.agent_runs.lock() {
        if let Some(entry) = runs.get_mut(run_id) {
            entry.turn_active = false;
        }
    }
}

/// Asks a turn's child to stop the way a terminal Ctrl-C would, falling
/// back to an outright kill if it doesn't go. SIGINT (not SIGKILL) is what
/// lets the CLI flush its session file, which is what makes the next
/// `--resume` land on the same conversation — verified live for both the
/// Stop button and the permission pause.
async fn interrupt_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGINT,
        );
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        return;
    }
    let _ = child.kill().await;
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
        worktree_root,
        resume_session_id,
        allowed_tools,
        fork_session,
        model,
        effort,
        fast,
        permission_mode,
    ) = {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        let entry = runs.get_mut(&run_id).ok_or("no such agent run")?;
        // One CLI process per run, always. Every caller that starts a turn
        // (`send_agent_message`, `respond_to_permission`) used to spawn
        // unconditionally, so a second turn begun while one was in flight
        // overwrote `cancel_tx`/`pid` — orphaning the first child as
        // unkillable and interleaving two event streams on one channel.
        if entry.turn_active {
            return Err(
                "This agent is already running a turn — wait for it to finish.".to_string(),
            );
        }
        entry.turn_active = true;
        let fork_session = entry.pending_fork;
        entry.pending_fork = false;
        (
            entry.kind,
            entry.worktree_root.clone(),
            entry.session_id.clone(),
            entry.allowed_tools.clone(),
            fork_session,
            entry.model.clone(),
            entry.effort.clone(),
            entry.fast,
            entry.permission_mode,
        )
    };

    // Read outside the `agent_runs` lock, both because it takes the
    // database lock and because holding two at once invites a deadlock.
    //
    // Settings' per-CLI binary path override applies to turns too, not
    // just to detection and one-shots. It used to be ignored here — turns
    // always spawned `kind.default_binary()` — so a CLI installed off the
    // app's PATH would detect correctly in Settings and then fail to
    // spawn. That hits Aider hardest, since it is normally installed into
    // a pipx/uv virtualenv a GUI process never sees.
    let (binary_path, extra_env) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let binary_path = crate::commands::agents::binary_path_for(&conn, kind)?;
        // Aider has no auth of its own; the selected model's provider
        // credentials travel as environment rather than argv, which would
        // publish them to every process on the machine via /proc.
        let extra_env = match kind {
            AgentKind::Aider => {
                crate::agents::aider::credentials::env_for_model(&conn, model.as_deref())
            }
            _ => Vec::new(),
        };
        (binary_path, extra_env)
    };

    // Declared once per provider, never branched on by kind here.
    let stream_deltas =
        crate::agents::capabilities::capabilities_for(kind).streaming == Streaming::Deltas;

    let session_dir = crate::agents::aider::session_dir(&state.app_data_dir);
    let ctx = TurnCtx {
        binary_path: &binary_path,
        worktree_root: &worktree_root,
        resume_session_id: resume_session_id.as_deref(),
        fork_session,
        allowed_tools: &allowed_tools,
        model: model.as_deref(),
        effort: effort.as_deref(),
        fast,
        permission_mode,
        stream_deltas,
        extra_env: &extra_env,
        session_dir: &session_dir,
    };
    let turn_started = std::time::Instant::now();
    let spawn = adapter::build_turn(kind, &ctx, &text);
    // A CLI with no session concept of its own gets one from its adapter.
    let assigned_session_id = spawn.assigned_session_id.clone();
    let mut command = spawn.command;

    // Every early return from here on has to clear `turn_active` again, or
    // the run is wedged into "already running a turn" forever.
    let spawned = command
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", kind.display_name()));
    let mut child = match spawned {
        Ok(child) => child,
        Err(message) => {
            clear_turn_active(&state, &run_id);
            return Err(message);
        }
    };

    if let Some(payload) = spawn.stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            // Dropping closes the write half — signals EOF.
        }
    }

    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            clear_turn_active(&state, &run_id);
            let _ = child.kill().await;
            return Err(format!("failed to capture {} output", kind.display_name()));
        }
    };
    let channel = agent_event_channel(&run_id);

    // A tool needing approval is reported mid-stream, so the decision to
    // stop the turn has to travel from the stdout reader back to the task
    // that owns the child. Carries the tool id so the pause event can name
    // the call the user is being asked about.
    let (pause_tx, mut pause_rx) = tokio::sync::oneshot::channel::<String>();
    let pause_on_permission = permission_mode == PermissionMode::Manual;

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    // Stopping a turn is a normal thing a user does, but from inside the
    // reader tasks it looks exactly like the child dying mid-stream. This
    // flag is set *before* the signal goes out, so both readers can tell
    // the two apart: Aider (a Python program) turns SIGINT into a
    // KeyboardInterrupt traceback on stderr, which is shutdown noise
    // rather than something the user needs to read.
    let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stdout_interrupted = interrupted.clone();
    let stderr_interrupted = interrupted.clone();

    let json_lines = adapter::uses_json_lines(kind);
    let finish_session_id = assigned_session_id
        .clone()
        .or_else(|| resume_session_id.clone());
    let stdout_task = tokio::spawn(async move {
        let mut pause_tx = Some(pause_tx);
        let mut tool_use_cache: ToolUseCache = ToolUseCache::new();
        // An adapter-minted id counts as learned from the first line, so a
        // CLI without sessions of its own still gets one recorded on the run.
        let mut learned_session_id = assigned_session_id;
        let mut pending_delta = String::new();
        let mut last_delta_flush = std::time::Instant::now();
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

            // Only meaningful for CLIs that emit JSON. Aider's output is
            // prose, which never parses as JSON, so applying this would
            // batch four lines of the model's reply together and rejoin
            // them with a literal `\n` — mangling every response.
            if json_lines {
                let looks_complete = serde_json::from_str::<serde_json::Value>(&buffer).is_ok();
                if !looks_complete && buffered_segments < 4 {
                    continue;
                }
            }

            let line = std::mem::take(&mut buffer);
            buffered_segments = 0;
            let (events, session_id) =
                adapter::parse_line(kind, &line, &mut tool_use_cache, stream_deltas);
            if session_id.is_some() {
                learned_session_id = session_id;
            }
            for mut event in events {
                if let AgentEvent::TurnResult { session_id, .. } = &mut event {
                    if session_id.is_empty() {
                        if let Some(learned) = &learned_session_id {
                            *session_id = learned.clone();
                        }
                    }
                }

                // Coalesce text deltas. A streaming CLI emits one per
                // token, and forwarding each straight through would mean an
                // IPC round-trip and a full transcript re-render per token
                // — the thing that makes naive streaming *slower* than no
                // streaming. Batching to a display-rate cadence keeps the
                // typing effect while bounding the work.
                if let AgentEvent::MessageDelta { text } = &event {
                    pending_delta.push_str(text);
                    if last_delta_flush.elapsed() >= DELTA_FLUSH_INTERVAL {
                        flush_delta(&stdout_app, &stdout_channel, &mut pending_delta);
                        last_delta_flush = std::time::Instant::now();
                    }
                    continue;
                }
                // Anything else has to come *after* the text it follows.
                flush_delta(&stdout_app, &stdout_channel, &mut pending_delta);
                last_delta_flush = std::time::Instant::now();

                // Only a gated run turns a refusal into a question. Outside
                // `Manual` — and after the one pause a turn gets — the CLI
                // refused on its own and kept going, so the transcript has
                // to report that rather than offer an Approve/Deny nothing
                // is waiting on (see `AgentEvent::PermissionDenied::gated`).
                if let AgentEvent::PermissionDenied { gated, .. } = &mut event {
                    *gated = pause_on_permission && pause_tx.is_some();
                }

                let _ = stdout_app.emit(&stdout_channel, &event);
                // Stop the turn at the point of the request rather than
                // letting the CLI barrel on past its own inline denial.
                // None of these CLIs has a live approve/deny round-trip
                // (verified against claude 2.1.224 — no
                // `--permission-prompt-tool`), so pausing here is what
                // turns "Manual" into a gate the user's answer actually
                // decides. Approving replays the action on the next turn
                // via `--resume` + a widened allow-list.
                if pause_on_permission {
                    if let AgentEvent::PermissionDenied { tool_use_id, .. } = &event {
                        if let Some(tx) = pause_tx.take() {
                            let _ = tx.send(tool_use_id.clone());
                        }
                    }
                }
            }
        }
        // Whatever the last flush didn't cover — a reply that ends on text
        // would otherwise lose its final fragment.
        flush_delta(&stdout_app, &stdout_channel, &mut pending_delta);

        // Adapters whose CLI prints no end-of-turn record get to build one
        // here from what they accumulated. Empty for the three CLIs whose
        // final JSON line already carries the result.
        for event in adapter::finish(
            kind,
            &tool_use_cache,
            finish_session_id.as_deref(),
            turn_started.elapsed().as_millis() as u64,
            stdout_interrupted.load(std::sync::atomic::Ordering::SeqCst),
        ) {
            let _ = stdout_app.emit(&stdout_channel, &event);
        }
        learned_session_id
    });

    let stderr_app = app.clone();
    let stderr_channel = channel.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut stderr_cache: ToolUseCache = ToolUseCache::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            // Once the user has asked to stop, everything the child says on
            // its way out is teardown noise — for Aider, a multi-page
            // KeyboardInterrupt traceback.
            if stderr_interrupted.load(std::sync::atomic::Ordering::SeqCst) {
                continue;
            }
            // Not every CLI treats stderr as purely an error channel —
            // the adapter decides what a line means (see
            // `adapter::parse_stderr_line`).
            for event in adapter::parse_stderr_line(kind, &line, &mut stderr_cache) {
                let _ = stderr_app.emit(&stderr_channel, &event);
            }
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = runs.get_mut(&run_id) {
            entry.cancel_tx = Some(cancel_tx);
            // Paired with `cancel_tx` for the Process Manager's benefit
            // (`processes.rs`): both describe "a turn is in flight", and
            // both are cleared together once the child exits below.
            entry.pid = child.id();
        }
    }

    let mut paused_for: Option<String> = None;
    let exit_code = tokio::select! {
        status = child.wait() => status.ok().and_then(|s| s.code()),
        cancel = &mut cancel_rx => {
            interrupted.store(true, std::sync::atomic::Ordering::SeqCst);
            match cancel {
                Ok(AgentCancelKind::Soft) => {
                    interrupt_child(&mut child).await;
                    None
                }
                _ => {
                    let _ = child.kill().await;
                    None
                }
            }
        }
        tool_use_id = &mut pause_rx => {
            match tool_use_id {
                // Same SIGINT-then-grace path the Stop button uses, which
                // is what keeps the session resumable: verified live that
                // a claude turn interrupted at the denial exits 0 and
                // `--resume` picks the same session id back up.
                Ok(id) => {
                    // Also a deliberate stop, just one Maestro asked for
                    // rather than the user.
                    interrupted.store(true, std::sync::atomic::Ordering::SeqCst);
                    interrupt_child(&mut child).await;
                    paused_for = Some(id);
                    None
                }
                // The reader finished without ever asking for permission,
                // so the sender was simply dropped. That races `child.wait()`
                // — stdout hits EOF exactly as the process exits — and
                // treating it as a pause would both interrupt an
                // already-finished turn and throw away its real exit code.
                Err(_) => child.wait().await.ok().and_then(|s| s.code()),
            }
        }
    };

    if let Some(tool_use_id) = paused_for {
        let _ = app.emit(&channel, &AgentEvent::AwaitingPermission { tool_use_id });
    }

    let learned_session_id = stdout_task.await.unwrap_or(None);
    {
        let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = runs.get_mut(&run_id) {
            entry.cancel_tx = None;
            entry.pid = None;
            entry.turn_active = false;
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
    pub effort: Option<String>,
    pub fast: bool,
    /// Must travel with session creation. Calling `set_permission_mode`
    /// before this command is a no-op because the run does not exist yet.
    pub permission_mode: PermissionMode,
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
        effort,
        fast,
        permission_mode,
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
                effort,
                fast,
                pending_fork: fork_session,
                allowed_tools: crate::agents::claude::DEFAULT_ALLOWED_TOOLS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                permission_mode,
                turn_active: false,
                cancel_tx: None,
                pid: None,
                started_at_ms: crate::processes::now_ms(),
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
            effort: None,
            fast: false,
            pending_fork: false,
            allowed_tools: crate::agents::claude::DEFAULT_ALLOWED_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            permission_mode: PermissionMode::default(),
            turn_active: false,
            cancel_tx: None,
            pid: None,
            started_at_ms: crate::processes::now_ms(),
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

/// Reports what an approval actually cost the run's trust, so the UI can
/// say so instead of quietly widening permissions behind the user's back.
/// `escalated_to_auto` is the honest bad news for Cursor/Codex: neither
/// has a per-invocation allow-list, so the only way to let one blocked
/// action through is to stop gating that run altogether.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOutcome {
    pub escalated_to_auto: bool,
    /// Whether this decision started another turn. `false` for a denial —
    /// the turn was already stopped at the request, so there is nothing to
    /// resume and nothing to pay for.
    pub resumed: bool,
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
) -> Result<PermissionOutcome, String> {
    let (tool_name, escalated_to_auto) = match &decision {
        PermissionDecision::Approve { tool_name } => {
            let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
            let entry = runs.get_mut(&run_id).ok_or("no such agent run")?;
            let escalated = match entry.kind {
                AgentKind::ClaudeCode => {
                    if !entry.allowed_tools.iter().any(|t| t == tool_name) {
                        entry.allowed_tools.push(tool_name.clone());
                    }
                    false
                }
                AgentKind::CursorAgent | AgentKind::Codex | AgentKind::Aider => {
                    let already_auto = entry.permission_mode == PermissionMode::Auto;
                    entry.permission_mode = PermissionMode::Auto;
                    !already_auto
                }
            };
            (tool_name.clone(), escalated)
        }
        // A denial has nothing to run. The turn was already stopped at the
        // request (see `run_turn`'s pause branch), and the CLI's own
        // session history already records the tool as denied — so spending
        // a whole extra turn, and the tokens for it, just to tell the model
        // "no" bought nothing.
        PermissionDecision::Deny => {
            return Ok(PermissionOutcome {
                escalated_to_auto: false,
                resumed: false,
            })
        }
    };

    let nudge = format!(
        "Permission granted for the {tool_name} action you just attempted — please proceed with it now."
    );
    run_turn(app, state, run_id, nudge).await?;
    Ok(PermissionOutcome {
        escalated_to_auto,
        resumed: true,
    })
}

/// Marks the run so its *next* turn branches the CLI session instead of
/// continuing it (`--fork-session` and friends — see each adapter's
/// `build_turn`). This is what lets a user edit an earlier message and
/// re-run from that point without destroying the original conversation:
/// the old session stays on disk exactly as it was, and the edited history
/// continues under a new id.
///
/// Only meaningful for a CLI whose `capabilities.fork_session` is true;
/// for the others the flag is simply never consumed, so calling this is
/// harmless but pointless — the frontend gates on the capability instead
/// of relying on that.
#[tauri::command]
pub async fn fork_agent_session(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
    let entry = runs.get_mut(&run_id).ok_or("no such agent run")?;
    entry.pending_fork = true;
    Ok(())
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
pub async fn set_agent_configuration(
    state: State<'_, AppState>,
    run_id: String,
    model: Option<String>,
    effort: Option<String>,
    fast: bool,
) -> Result<(), String> {
    let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = runs.get_mut(&run_id) {
        entry.model = model;
        entry.effort = effort;
        entry.fast = fast;
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
