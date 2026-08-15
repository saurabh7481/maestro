//! Codex CLI adapter (docs/ROADMAP.md Phase 6) — **best-effort and
//! UNVERIFIED**. Unlike `claude.rs`/`cursor_agent.rs`, this was not
//! checked against a live install: Codex isn't available on any machine
//! this project has been developed on (`which codex` → not found).
//!
//! Everything below is built from `docs/ARCHITECTURE.md`'s §3.2 research
//! (`codex exec --json`, `resume --last`/`resume <id>`) plus general
//! knowledge of Codex's event-stream shape, which real Codex releases
//! have been known to change. Treat this the same way `ARCHITECTURE.md`'s
//! stale `--permission-prompt-tool` assumption for Claude turned out to
//! need correcting once actually run: **before relying on this in
//! production, repeat the live-spike methodology from
//! `claude.rs`/`cursor_agent.rs`'s module docs against a real `codex`
//! binary** and fix whatever's wrong. Until then:
//! - `detect()` (`registry.rs`) never reports Codex as installed/
//!   authenticated unless it actually finds and can query the binary —
//!   this adapter's incorrectness (if any) only matters once someone has
//!   Codex installed, at which point failures surface as loud
//!   `AgentEvent::Error`s (real stderr / JSON parse failures), never a
//!   silent hang.
//! - `parse_line` is deliberately conservative: it recognizes a small set
//!   of plausible event shapes and forwards everything else as `Raw`
//!   rather than guessing further, so no information is silently
//!   dropped even where it can't be normalized into a rich tool card.

use crate::agents::adapter::{PermissionMode, ToolUseCache, TurnCtx, TurnSpawn};
use crate::agents::events::AgentEvent;
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;

pub fn build_turn(ctx: &TurnCtx, text: &str) -> TurnSpawn {
    let mut cmd = Command::new(ctx.binary_path);
    cmd.arg("exec").arg("--json");
    if let Some(id) = ctx.resume_session_id {
        cmd.arg("resume").arg(id);
    }
    if ctx.permission_mode == PermissionMode::Auto {
        // Unverified flag name — Codex's exact non-interactive
        // full-auto flag wasn't confirmed against a real binary (see
        // module doc). If wrong, this fails loudly (a real CLI error
        // surfaced via stderr), not silently.
        cmd.arg("--dangerously-bypass-approvals-and-sandbox");
    }
    // `PermissionMode::Plan` has no confirmed Codex equivalent (see
    // module doc) — falls through and behaves like `Manual` rather than
    // guessing at a flag.
    if let Some(model) = ctx.model {
        cmd.arg("--model").arg(model);
    }
    cmd.arg(text);
    cmd.current_dir(ctx.worktree_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    TurnSpawn {
        command: cmd,
        stdin_payload: None,
    }
}

/// Some Codex protocol shapes nest the discriminator under `msg.type`
/// rather than a top-level `type` — check both rather than committing to
/// one, since neither is confirmed.
fn event_type(value: &Value) -> &str {
    value
        .get("type")
        .and_then(|t| t.as_str())
        .or_else(|| {
            value
                .get("msg")
                .and_then(|m| m.get("type"))
                .and_then(|t| t.as_str())
        })
        .unwrap_or("")
}

fn msg_field(value: &Value) -> &Value {
    value.get("msg").unwrap_or(value)
}

pub fn parse_line(line: &str, _cache: &mut ToolUseCache) -> (Vec<AgentEvent>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return (
            vec![AgentEvent::Error {
                message: format!("Malformed JSON line from codex: {line}"),
            }],
            None,
        );
    };

    let msg = msg_field(&value);
    match event_type(&value) {
        "session_configured" | "task_started" => {
            let session_id = value
                .get("session_id")
                .or_else(|| msg.get("session_id"))
                .and_then(|s| s.as_str())
                .map(str::to_string);
            (Vec::new(), session_id)
        }
        "agent_message" => {
            let text = msg
                .get("message")
                .or_else(|| msg.get("text"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            if text.is_empty() {
                (Vec::new(), None)
            } else {
                (
                    vec![AgentEvent::Message {
                        role: "assistant".to_string(),
                        text: text.to_string(),
                    }],
                    None,
                )
            }
        }
        "agent_reasoning" => {
            let text = msg.get("text").and_then(|s| s.as_str()).unwrap_or("");
            if text.is_empty() {
                (Vec::new(), None)
            } else {
                (
                    vec![AgentEvent::Thinking {
                        text: text.to_string(),
                    }],
                    None,
                )
            }
        }
        "exec_command_begin" => {
            let id = value
                .get("id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let command = msg
                .get("command")
                .map(|c| {
                    c.as_array()
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|p| p.as_str())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_else(|| c.to_string())
                })
                .unwrap_or_default();
            (
                vec![AgentEvent::ToolCall {
                    id,
                    name: "Bash".to_string(),
                    input: serde_json::json!({ "command": command }),
                }],
                None,
            )
        }
        "exec_command_end" => {
            let id = value
                .get("id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let exit_code = msg.get("exit_code").and_then(|n| n.as_i64()).unwrap_or(0);
            let output = msg
                .get("aggregated_output")
                .or_else(|| msg.get("stdout"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            (
                vec![AgentEvent::ToolResult {
                    tool_use_id: id,
                    content: output,
                    is_error: exit_code != 0,
                    diff_added: None,
                    diff_removed: None,
                }],
                None,
            )
        }
        "patch_apply_begin" => {
            let id = value
                .get("id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let path = msg
                .get("path")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            (
                vec![AgentEvent::ToolCall {
                    id,
                    name: "Edit".to_string(),
                    input: serde_json::json!({ "file_path": path }),
                }],
                None,
            )
        }
        "patch_apply_end" => {
            let id = value
                .get("id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let success = msg.get("success").and_then(|b| b.as_bool()).unwrap_or(true);
            (
                vec![AgentEvent::ToolResult {
                    tool_use_id: id,
                    content: msg
                        .get("message")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string(),
                    is_error: !success,
                    diff_added: None,
                    diff_removed: None,
                }],
                None,
            )
        }
        "task_complete" => {
            let session_id = value
                .get("session_id")
                .or_else(|| msg.get("session_id"))
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            (
                vec![AgentEvent::TurnResult {
                    session_id,
                    is_error: false,
                    total_cost_usd: None,
                    duration_ms: 0,
                    num_turns: 1,
                    result_text: msg
                        .get("last_agent_message")
                        .and_then(|s| s.as_str())
                        .map(str::to_string),
                }],
                None,
            )
        }
        "error" => (
            vec![AgentEvent::Error {
                message: msg
                    .get("message")
                    .and_then(|s| s.as_str())
                    .unwrap_or("codex error")
                    .to_string(),
            }],
            None,
        ),
        _ => (vec![AgentEvent::Raw { json: value }], None),
    }
}
