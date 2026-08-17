//! Cursor Agent adapter (docs/ROADMAP.md Phase 6). Live-verified against
//! the installed CLI (2026.08.11-e8db854) — this is the user's daily
//! driver, so this adapter got the same live-spike rigor Claude's did in
//! Phase 5, not a best-effort guess (contrast `codex.rs`).
//!
//! ## Findings from the live protocol spike
//!
//! - **Workspace trust gate**: non-interactive mode refuses to run at all
//!   without `--trust` (or `--force`/`--yolo`) — prints a trust prompt
//!   and exits 0 with no JSON output. Maestro always passes `--trust`
//!   (per-directory, same trust boundary the user already crossed by
//!   opening the worktree in Maestro) but never `--force`/`--yolo` unless
//!   the "dangerously skip permissions" toggle is on.
//! - **No `--input-format`/stdin protocol**: the prompt is a plain
//!   positional argument, and `--resume <chatId>` plus a new prompt
//!   continues that session non-interactively — verified end-to-end,
//!   same `session_id` throughout.
//! - **Permission model is config-file-driven, not per-invocation**: this
//!   CLI has no `--allowedTools`/`--permission-mode` equivalent. Approval
//!   policy lives in `~/.cursor/cli-config.json` (`approvalMode`,
//!   `permissions.allow`/`deny`) — the same config the interactive
//!   `cursor-agent`/Cursor IDE use. Maestro deliberately does **not**
//!   read or rewrite that file (it's global, shared with the user's IDE,
//!   not Maestro-tab-scoped) — every turn just runs with `--trust` and
//!   whatever the user has already configured. With this machine's
//!   config (`approvalMode: "unrestricted"`), every tool call in the
//!   spike ran with no gating at all, including file writes — so a
//!   *live* denial was never actually observed. The "denied" branch in
//!   `parse_line` below is a documented heuristic (a `tool_call`
//!   `completed` whose `result` has no `success` key), not confirmed
//!   against a real denial event — flag for follow-up if it doesn't
//!   match reality once exercised against a stricter config.
//! - Real event shapes (confirmed): `system/init` (session_id, model,
//!   `permissionMode`), `thinking` with `subtype: "delta"|"completed"`
//!   (streamed — accumulated here into one block per turn-segment, not
//!   one event per delta), `assistant` (`message.content[].text`),
//!   `tool_call` `started`/`completed` with a single
//!   `{shellToolCall|editToolCall|...}` key under `tool_call` carrying
//!   `args` and (on `completed`) `result`, `result` (final,
//!   `subtype:"success"`, `result` text field — same shape `--output-
//!   format json`'s one-shot object uses, see `one_shot.rs`).
//!
//! Fixture lines captured during the spike live under
//! `src-tauri/tests/fixtures/cursor/`.

use crate::agents::adapter::{PermissionMode, ToolUseCache, TurnCtx, TurnSpawn};
use crate::agents::events::AgentEvent;
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;

/// Sentinel key in the shared `ToolUseCache` used to accumulate
/// `thinking` deltas across lines within one turn — the cache's
/// `(String, Value)` shape is (name, input) for tool calls, reused here
/// as (accumulated_text, Value::Null) since thinking has no id of its
/// own to key by.
const THINKING_ACCUMULATOR_KEY: &str = "__thinking__";

pub fn build_turn(ctx: &TurnCtx, text: &str) -> TurnSpawn {
    let mut cmd = Command::new(ctx.binary_path);
    cmd.arg("-p").arg(text);
    cmd.args(["--output-format", "stream-json", "--trust"]);
    if ctx.stream_deltas {
        // Changes `assistant` lines from finished blocks into fragments —
        // `parse_line` has to be told the same thing, since the two look
        // identical on the wire.
        cmd.arg("--stream-partial-output");
    }
    if let Some(id) = ctx.resume_session_id {
        cmd.arg("--resume").arg(id);
    }
    if let Some(model) = ctx.model {
        cmd.arg("--model").arg(model);
    }
    match ctx.permission_mode {
        PermissionMode::Auto => {
            cmd.arg("--yolo");
        }
        PermissionMode::Plan => {
            cmd.arg("--mode").arg("plan");
        }
        PermissionMode::Manual => {}
    }
    cmd.current_dir(ctx.worktree_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    TurnSpawn {
        command: cmd,
        stdin_payload: None,
        // This CLI names its own sessions.
        assigned_session_id: None,
    }
}

/// `tool_call.tool_call` is a flat object with the tool-type variant key
/// (`shellToolCall`, `editToolCall`, …) *alongside* sibling metadata keys
/// (`hookAdditionalContexts`, `toolCallId`, `startedAtMs`, …) — it is
/// **not** a single-key object, so picking "the first key" is wrong
/// (confirmed the hard way: serde_json's default map is a `BTreeMap`,
/// which sorted `hookAdditionalContexts` before `shellToolCall` and
/// silently misidentified every tool call until this was fixed). Must
/// specifically look for a key matching a known `*ToolCall` variant name.
fn tool_kind(tool_call: &Value) -> Option<(&'static str, &Value)> {
    let obj = tool_call.as_object()?;
    let (key, val) = obj.iter().find(|(k, _)| k.ends_with("ToolCall"))?;
    let name = match key.as_str() {
        "shellToolCall" => "Bash",
        "editToolCall" => "Edit",
        "writeToolCall" => "Write",
        "readToolCall" => "Read",
        "grepToolCall" | "searchToolCall" => "Grep",
        "globToolCall" => "Glob",
        _ => "Tool",
    };
    Some((name, val))
}

fn result_content(name: &str, result: &Value) -> (String, bool, Option<u32>, Option<u32>) {
    let Some(success) = result.get("success") else {
        // No `success` key — see the module doc: unverified whether this
        // is really the denial shape, but it's the only structurally
        // distinct "something's off" signal available.
        let message = result
            .as_object()
            .and_then(|obj| obj.iter().next())
            .and_then(|(_, v)| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "Tool call did not complete successfully.".to_string());
        return (message, true, None, None);
    };
    match name {
        "Edit" | "Write" => {
            let added = success
                .get("linesAdded")
                .and_then(|n| n.as_u64())
                .map(|n| n as u32);
            let removed = success
                .get("linesRemoved")
                .and_then(|n| n.as_u64())
                .map(|n| n as u32);
            let content = success
                .get("diffString")
                .and_then(|s| s.as_str())
                .or_else(|| success.get("message").and_then(|s| s.as_str()))
                .unwrap_or("")
                .to_string();
            (content, false, added, removed)
        }
        "Bash" => {
            let exit_code = success
                .get("exitCode")
                .and_then(|n| n.as_i64())
                .unwrap_or(0);
            let stdout = success
                .get("interleavedOutput")
                .or_else(|| success.get("stdout"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let stderr = success.get("stderr").and_then(|s| s.as_str()).unwrap_or("");
            let content = if stderr.is_empty() {
                stdout.to_string()
            } else {
                format!("{stdout}\n{stderr}")
            };
            (content, exit_code != 0, None, None)
        }
        _ => {
            let content = serde_json::to_string_pretty(success).unwrap_or_default();
            (content, false, None, None)
        }
    }
}

pub fn parse_line(
    line: &str,
    cache: &mut ToolUseCache,
    stream_deltas: bool,
) -> (Vec<AgentEvent>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return (
            vec![AgentEvent::Error {
                message: format!("Malformed JSON line from cursor-agent: {line}"),
            }],
            None,
        );
    };

    let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let subtype = value.get("subtype").and_then(|t| t.as_str()).unwrap_or("");

    match event_type {
        "system" if subtype == "init" => {
            let session_id = value
                .get("session_id")
                .and_then(|s| s.as_str())
                .map(str::to_string);
            (Vec::new(), session_id)
        }
        "user" => (Vec::new(), None), // echo of what we sent — already shown locally
        "thinking" => match subtype {
            "delta" => {
                let delta = value.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let entry = cache
                    .entry(THINKING_ACCUMULATOR_KEY.to_string())
                    .or_insert_with(|| (String::new(), Value::Null));
                entry.0.push_str(delta);
                (Vec::new(), None)
            }
            "completed" => {
                let text = cache
                    .remove(THINKING_ACCUMULATOR_KEY)
                    .map(|(t, _)| t)
                    .unwrap_or_default();
                if text.is_empty() {
                    (Vec::new(), None)
                } else {
                    (vec![AgentEvent::Thinking { text }], None)
                }
            }
            _ => (Vec::new(), None),
        },
        "assistant" => {
            let blocks = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            let events = blocks
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) != Some("text") {
                        return None;
                    }
                    let text = b.get("text").and_then(|t| t.as_str())?;
                    if text.is_empty() {
                        return None;
                    }
                    // Under `--stream-partial-output` these lines are
                    // fragments, not finished blocks — verified live: a
                    // one-sentence reply arrived as 11 `assistant` events
                    // and no consolidated one, with the full text only on
                    // the final `result`.
                    Some(if stream_deltas {
                        AgentEvent::MessageDelta {
                            text: text.to_string(),
                        }
                    } else {
                        AgentEvent::Message {
                            role: "assistant".to_string(),
                            text: text.to_string(),
                        }
                    })
                })
                .collect();
            (events, None)
        }
        "tool_call" => {
            let Some(tool_call) = value.get("tool_call") else {
                return (vec![AgentEvent::Raw { json: value }], None);
            };
            let Some((name, inner)) = tool_kind(tool_call) else {
                return (vec![AgentEvent::Raw { json: value }], None);
            };
            let call_id = value
                .get("call_id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            match subtype {
                "started" => {
                    let input = inner.get("args").cloned().unwrap_or(Value::Null);
                    cache.insert(call_id.clone(), (name.to_string(), input.clone()));
                    (
                        vec![AgentEvent::ToolCall {
                            id: call_id,
                            name: name.to_string(),
                            input,
                        }],
                        None,
                    )
                }
                "completed" => {
                    let Some(result) = inner.get("result") else {
                        return (Vec::new(), None);
                    };
                    let (content, is_denial_or_error, diff_added, diff_removed) =
                        result_content(name, result);
                    if is_denial_or_error && result.get("success").is_none() {
                        let tool_input = cache
                            .get(&call_id)
                            .map(|(_, i)| i.clone())
                            .unwrap_or(Value::Null);
                        return (
                            vec![AgentEvent::PermissionDenied {
                                tool_name: name.to_string(),
                                tool_use_id: call_id,
                                tool_input,
                                message: content,
                            }],
                            None,
                        );
                    }
                    (
                        vec![AgentEvent::ToolResult {
                            tool_use_id: call_id,
                            content,
                            is_error: is_denial_or_error,
                            diff_added,
                            diff_removed,
                        }],
                        None,
                    )
                }
                _ => (Vec::new(), None),
            }
        }
        "result" => {
            let session_id = value
                .get("session_id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            (
                vec![AgentEvent::TurnResult {
                    session_id,
                    is_error: value
                        .get("is_error")
                        .and_then(|b| b.as_bool())
                        .unwrap_or(subtype != "success"),
                    total_cost_usd: None, // not reported by this CLI
                    duration_ms: value
                        .get("duration_ms")
                        .and_then(|n| n.as_u64())
                        .unwrap_or(0),
                    num_turns: 1,
                    input_tokens: value
                        .get("usage")
                        .and_then(|u| u.get("inputTokens"))
                        .and_then(|n| n.as_u64()),
                    output_tokens: value
                        .get("usage")
                        .and_then(|u| u.get("outputTokens"))
                        .and_then(|n| n.as_u64()),
                    cache_read_tokens: value
                        .get("usage")
                        .and_then(|u| u.get("cacheReadTokens"))
                        .and_then(|n| n.as_u64()),
                    cache_write_tokens: value
                        .get("usage")
                        .and_then(|u| u.get("cacheWriteTokens"))
                        .and_then(|n| n.as_u64()),
                    // Not reported by this CLI.
                    context_window: None,
                    result_text: value
                        .get("result")
                        .and_then(|s| s.as_str())
                        .map(str::to_string),
                }],
                None,
            )
        }
        _ => (vec![AgentEvent::Raw { json: value }], None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/tests/fixtures/cursor/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        fs::read_to_string(path).unwrap()
    }

    /// Mirrors `manager.rs`'s stdout-reading loop's line-reassembly — the
    /// fixtures contain real captured lines where a `call_id` embeds a
    /// raw newline byte, splitting one JSON object in two (see
    /// `manager.rs`'s comment). A plain line-split here would make these
    /// tests fail on real data.
    fn parse_all(text: &str) -> Vec<AgentEvent> {
        let mut cache = HashMap::new();
        let mut events = Vec::new();
        let mut buffer = String::new();
        let mut buffered_segments = 0u32;
        for raw_line in text.lines() {
            if raw_line.trim().is_empty() && buffer.is_empty() {
                continue;
            }
            if !buffer.is_empty() {
                buffer.push_str("\\n");
            }
            buffer.push_str(raw_line);
            buffered_segments += 1;

            let looks_complete = serde_json::from_str::<Value>(&buffer).is_ok();
            if !looks_complete && buffered_segments < 4 {
                continue;
            }

            let line = std::mem::take(&mut buffer);
            buffered_segments = 0;
            let (mut line_events, _) = parse_line(&line, &mut cache, false);
            events.append(&mut line_events);
        }
        events
    }

    #[test]
    fn parses_simple_reply_with_accumulated_thinking() {
        let events = parse_all(&fixture("01_simple_no_tool.jsonl"));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Message { text, .. } if text == "PONG")));
        // Multiple `thinking`/`delta` lines in the fixture must collapse
        // into exactly one `Thinking` event, not one per delta.
        let thinking_count = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Thinking { .. }))
            .count();
        assert_eq!(thinking_count, 1);
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnResult { .. })));
        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::TurnResult {
                input_tokens: Some(14737),
                output_tokens: Some(34),
                cache_read_tokens: Some(5632),
                ..
            }
        )));
    }

    #[test]
    fn parses_shell_tool_call_and_result() {
        let events = parse_all(&fixture("02_shell_tool_call.jsonl"));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "Bash")));
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolResult {
                is_error: false,
                ..
            }
        )));
    }

    #[test]
    fn parses_edit_tool_call_with_real_diff_counts() {
        let events = parse_all(&fixture("03_edit_tool_call.jsonl"));
        let result = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolResult {
                    diff_added,
                    diff_removed,
                    ..
                } => Some((diff_added, diff_removed)),
                _ => None,
            })
            .expect("expected a ToolResult with diff counts");
        assert_eq!(result.0, &Some(1));
        assert_eq!(result.1, &Some(0));
    }

    /// With `--stream-partial-output` an `assistant` line is a fragment,
    /// not a finished block — the same shape means two different things,
    /// so the parser has to be told which run it is reading. Captured
    /// live: a one-sentence reply arrived as 11 of these.
    #[test]
    fn assistant_lines_become_deltas_only_when_streaming() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The"}]},"session_id":"s"}"#;

        let mut cache = HashMap::new();
        let (streamed, _) = parse_line(line, &mut cache, true);
        assert!(
            matches!(streamed.as_slice(), [AgentEvent::MessageDelta { text }] if text == "The")
        );

        let mut cache = HashMap::new();
        let (whole, _) = parse_line(line, &mut cache, false);
        assert!(
            matches!(whole.as_slice(), [AgentEvent::Message { text, .. }] if text == "The"),
            "without the flag these are complete blocks, not fragments"
        );
    }

    #[test]
    fn malformed_line_becomes_an_error_event_not_a_panic() {
        let mut cache = HashMap::new();
        let (events, session_id) = parse_line("{not valid json", &mut cache, false);
        assert!(session_id.is_none());
        assert!(matches!(events.as_slice(), [AgentEvent::Error { .. }]));
    }
}
