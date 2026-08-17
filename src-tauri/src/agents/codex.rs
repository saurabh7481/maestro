//! Codex CLI adapter (docs/ROADMAP.md Phase 6), live-verified against
//! standalone Codex CLI 0.147.0 using ChatGPT authentication. Current
//! JSONL emits `thread.started`, `item.completed`, and `turn.completed`;
//! legacy event names remain accepted for compatibility with older builds.
//!
//! Unknown item types still forward as `Raw` rather than disappearing,
//! so future CLI protocol changes remain visible and diagnosable.

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
    // `codex exec --help` (0.147.0) documents both of these, so each mode
    // maps to a real gate rather than a decorative one. `Plan` used to
    // fall through to `Manual` with no flag at all, which made the
    // composer's read-only mode a lie for this CLI.
    match ctx.permission_mode {
        PermissionMode::Auto => {
            cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        }
        // Read-only: the agent can look but not touch, which is exactly
        // what Plan promises.
        PermissionMode::Plan => {
            cmd.args(["--sandbox", "read-only"]);
        }
        // Edits confined to the worktree, no network and nothing outside
        // it. `codex exec` has no interactive approval to route back here,
        // so this sandbox *is* the gate for Manual.
        PermissionMode::Manual => {
            cmd.args(["--sandbox", "workspace-write"]);
        }
    }
    if let Some(model) = ctx.model {
        cmd.arg("--model").arg(model);
    }
    if let Some(effort) = ctx.effort {
        cmd.arg("-c")
            .arg(format!("model_reasoning_effort=\"{effort}\""));
    }
    if ctx.fast {
        cmd.arg("-c").arg("service_tier=\"priority\"");
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
        "thread.started" => {
            let session_id = value
                .get("thread_id")
                .and_then(|s| s.as_str())
                .map(str::to_string);
            (Vec::new(), session_id)
        }
        "turn.started" => (Vec::new(), None),
        "item.completed" => {
            let item = value.get("item").unwrap_or(&Value::Null);
            match item.get("type").and_then(|kind| kind.as_str()) {
                Some("agent_message") => {
                    let text = item
                        .get("text")
                        .and_then(|text| text.as_str())
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
                Some("reasoning") => {
                    let text = item
                        .get("text")
                        .and_then(|text| text.as_str())
                        .unwrap_or("");
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
                _ => (vec![AgentEvent::Raw { json: value }], None),
            }
        }
        "turn.completed" => (
            vec![AgentEvent::TurnResult {
                session_id: String::new(),
                is_error: false,
                total_cost_usd: None,
                duration_ms: 0,
                num_turns: 1,
                input_tokens: value
                    .get("usage")
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(|n| n.as_u64()),
                output_tokens: value
                    .get("usage")
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|n| n.as_u64()),
                cache_read_tokens: value
                    .get("usage")
                    .and_then(|u| u.get("cached_input_tokens"))
                    .and_then(|n| n.as_u64()),
                cache_write_tokens: None,
                context_window: None,
                result_text: None,
            }],
            None,
        ),
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
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    context_window: None,
                    result_text: msg
                        .get("last_agent_message")
                        .and_then(|s| s.as_str())
                        .map(str::to_string),
                }],
                None,
            )
        }
        // A turn that failed emits this *instead of* `turn.completed`, so
        // without it the run never gets a `TurnResult` and the UI sits on
        // "working" until the process exits, then blames a crash. Observed
        // live: hitting the usage limit produces `error` immediately
        // followed by `turn.failed`.
        "turn.failed" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .or_else(|| msg.get("message"))
                .and_then(|s| s.as_str())
                .unwrap_or("The Codex turn failed.")
                .to_string();
            (
                vec![AgentEvent::TurnResult {
                    session_id: String::new(),
                    is_error: true,
                    total_cost_usd: None,
                    duration_ms: 0,
                    num_turns: 1,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    context_window: None,
                    result_text: Some(message),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_thread_and_message_events() {
        let mut cache = ToolUseCache::new();
        let (events, session_id) = parse_line(
            r#"{"type":"thread.started","thread_id":"thread-123"}"#,
            &mut cache,
        );
        assert!(events.is_empty());
        assert_eq!(session_id.as_deref(), Some("thread-123"));

        let (events, _) = parse_line(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}"#,
            &mut cache,
        );
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::Message { role, text }] if role == "assistant" && text == "hello"
        ));
    }

    #[test]
    fn current_turn_completed_becomes_a_result() {
        let mut cache = ToolUseCache::new();
        let (events, _) = parse_line(
            r#"{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}"#,
            &mut cache,
        );
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::TurnResult {
                input_tokens: Some(12),
                output_tokens: Some(3),
                ..
            }]
        ));
    }

    /// Captured from a real `codex exec --json` run that hit the account's
    /// usage limit. `turn.failed` replaces `turn.completed`, so treating it
    /// as an unknown event left the turn looking like it was still running.
    #[test]
    fn turn_failed_ends_the_turn_with_the_reason() {
        let mut cache = ToolUseCache::new();
        let (events, _) = parse_line(
            r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#,
            &mut cache,
        );
        let [AgentEvent::TurnResult {
            is_error,
            result_text,
            ..
        }] = events.as_slice()
        else {
            panic!("expected a single TurnResult, got {events:?}");
        };
        assert!(is_error);
        assert_eq!(result_text.as_deref(), Some("You've hit your usage limit."));
    }

    #[test]
    fn each_permission_mode_maps_to_a_real_sandbox_flag() {
        fn args_for(mode: PermissionMode) -> Vec<String> {
            let ctx = TurnCtx {
                binary_path: "codex",
                worktree_root: "/tmp",
                resume_session_id: None,
                fork_session: false,
                allowed_tools: &[],
                model: None,
                effort: None,
                fast: false,
                permission_mode: mode,
                stream_deltas: false,
            };
            build_turn(&ctx, "hi")
                .command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        }

        assert!(args_for(PermissionMode::Plan)
            .windows(2)
            .any(|w| w == ["--sandbox".to_string(), "read-only".to_string()]));
        assert!(args_for(PermissionMode::Manual)
            .windows(2)
            .any(|w| w == ["--sandbox".to_string(), "workspace-write".to_string()]));
        assert!(args_for(PermissionMode::Auto)
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
        // Plan must not also carry the bypass flag — that would be the
        // exact "read-only mode that can still write" bug this guards.
        assert!(!args_for(PermissionMode::Plan)
            .iter()
            .any(|a| a.starts_with("--dangerously")));
    }
}
