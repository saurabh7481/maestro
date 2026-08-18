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
//!   first spike ran with no gating at all, so a live denial went
//!   unobserved and the "denied" branch was written as a guess: *any*
//!   `result` without a `success` key. That guess was wrong in both
//!   directions, and has since been replaced — a second spike (running
//!   the CLI against a throwaway `HOME` carrying a `permissions.deny`
//!   rule) captured the real shape, `{"rejected":{…}}`, see
//!   `result_content`. Because a refusal is a distinct variant, an
//!   ordinary failed tool call no longer masquerades as a permission
//!   request.
//! - Real event shapes (confirmed): `system/init` (session_id, model,
//!   `permissionMode`), `thinking` with `subtype: "delta"|"completed"`
//!   (streamed — accumulated here into one block per turn-segment, not
//!   one event per delta), `assistant` (`message.content[].text`),
//!   `tool_call` `started`/`completed` with a single
//!   `{shellToolCall|editToolCall|...}` key under `tool_call` carrying
//!   `args` and (on `completed`) `result` — a `oneof` whose variant is
//!   `success`/`rejected`/`error`, `result` (final,
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

/// What a `tool_call`/`completed` result says happened.
enum ToolOutcome {
    /// Ran (successfully or not) — `is_error` distinguishes the two.
    Ran {
        content: String,
        is_error: bool,
        diff_added: Option<u32>,
        diff_removed: Option<u32>,
    },
    /// The CLI's own permission layer refused to run it. Nothing Maestro
    /// sent caused this and nothing Maestro sends can retry it in place.
    Refused { message: String },
}

/// `result` is a protobuf `oneof` on the wire, so it arrives as a
/// single-variant object: `success` on the happy path, `rejected` when
/// the CLI's permission layer blocked the call, `error` when the tool ran
/// and failed. Confirmed live on 2026.08.11-e8db854 by adding a
/// `permissions.deny` rule and watching the refusal come back as
/// `{"rejected":{"command","workingDirectory","reason","isReadonly"}}` —
/// which replaces the module doc's earlier guess that *any* missing
/// `success` key meant a denial. That guess is what made an ordinary
/// unrecognized result render as an Approve/Deny card reading "Tool call
/// did not complete successfully.": `reason` is a string but `rejected`
/// itself is an object, so the old first-key-as-string extraction always
/// fell through to that placeholder.
fn result_content(name: &str, result: &Value) -> ToolOutcome {
    let Some(success) = result.get("success") else {
        // `permissionDenied` is the variant name some tool types use for
        // the same thing (seen in the CLI's own result-mapping code).
        if let Some(refusal) = result
            .get("rejected")
            .or_else(|| result.get("permissionDenied"))
        {
            let reason = refusal
                .get("reason")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .trim();
            let message = if reason.is_empty() {
                format!(
                    "cursor-agent refused to run this {name} call. Its permission rules live in \
                     ~/.cursor/cli-config.json (`approvalMode`, `permissions.deny`), which Maestro \
                     deliberately does not edit."
                )
            } else {
                reason.to_string()
            };
            return ToolOutcome::Refused { message };
        }
        // Anything else (`error`, or a variant this build doesn't know) is
        // a failed tool call, not a permission question — surface it as an
        // error result so it reads as what it is.
        let content = result
            .get("error")
            .and_then(|e| e.get("error").or(Some(e)))
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| serde_json::to_string_pretty(result).unwrap_or_default());
        return ToolOutcome::Ran {
            content,
            is_error: true,
            diff_added: None,
            diff_removed: None,
        };
    };
    let (content, is_error, diff_added, diff_removed) = match name {
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
    };
    ToolOutcome::Ran {
        content,
        is_error,
        diff_added,
        diff_removed,
    }
}

/// Under `--stream-partial-output` an `assistant` line is *usually* a
/// fragment — but the CLI also re-sends each finished text segment whole,
/// and feeding that consolidated copy through as one more fragment is what
/// made every reply render twice (the reported bug: "I'll pull AD-743
/// …codebase.I'll pull AD-743 …codebase."). Captured live on
/// 2026.08.11-e8db854, see `tests/fixtures/cursor/04_partial_output.jsonl`.
///
/// The two are structurally distinct: a fragment always carries
/// `timestamp_ms` and never `model_call_id`, while the consolidated copy
/// either carries `model_call_id` (a segment that ends because a tool call
/// follows) or drops `timestamp_ms` (the last segment of the turn). Both
/// shapes appear in the fixture, which is why neither key alone is enough.
///
/// Emitting these as a whole `Message` rather than a delta also lets the
/// transcript treat the block as authoritative and repair a dropped
/// fragment — the same contract `claude.rs` relies on.
fn is_consolidated_assistant(value: &Value) -> bool {
    value.get("model_call_id").is_some() || value.get("timestamp_ms").is_none()
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
            let as_deltas = stream_deltas && !is_consolidated_assistant(&value);
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
                    // Under `--stream-partial-output` most of these lines
                    // are fragments rather than finished blocks — but not
                    // the consolidated re-send that closes each segment,
                    // see `is_consolidated_assistant`.
                    Some(if as_deltas {
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
                    match result_content(name, result) {
                        ToolOutcome::Refused { message } => {
                            let tool_input = cache
                                .get(&call_id)
                                .map(|(_, i)| i.clone())
                                .unwrap_or(Value::Null);
                            (
                                vec![AgentEvent::PermissionDenied {
                                    tool_name: name.to_string(),
                                    tool_use_id: call_id,
                                    tool_input,
                                    message,
                                    gated: false, // `run_turn` decides, see events.rs
                                }],
                                None,
                            )
                        }
                        ToolOutcome::Ran {
                            content,
                            is_error,
                            diff_added,
                            diff_removed,
                        } => (
                            vec![AgentEvent::ToolResult {
                                tool_use_id: call_id,
                                content,
                                is_error,
                                diff_added,
                                diff_removed,
                            }],
                            None,
                        ),
                    }
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
        parse_all_with(text, false)
    }

    fn parse_all_with(text: &str, stream_deltas: bool) -> Vec<AgentEvent> {
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
            let (mut line_events, _) = parse_line(&line, &mut cache, stream_deltas);
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

    /// With `--stream-partial-output` an `assistant` line is *usually* a
    /// fragment — the same shape means two different things, so the parser
    /// has to be told which run it is reading. Captured live: a
    /// one-sentence reply arrived as 11 of these. Note the `timestamp_ms`:
    /// every fragment carries one, and `is_consolidated_assistant` reads
    /// it, so a line without it is not a representative fragment.
    #[test]
    fn assistant_lines_become_deltas_only_when_streaming() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The"}]},"session_id":"s","timestamp_ms":1787030681469}"#;

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

    /// Both shapes the consolidated re-send arrives in, each captured live:
    /// mid-turn it keeps `timestamp_ms` and gains `model_call_id`; at the
    /// end of the turn it simply has neither.
    #[test]
    fn either_consolidated_shape_is_recognised_while_streaming() {
        for line in [
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The end."}]},"session_id":"s","model_call_id":"m-0","timestamp_ms":1787030681470}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The end."}]},"session_id":"s"}"#,
        ] {
            let mut cache = HashMap::new();
            let (events, _) = parse_line(line, &mut cache, true);
            assert!(
                matches!(events.as_slice(), [AgentEvent::Message { text, .. }] if text == "The end."),
                "expected a whole message, got {events:?}"
            );
        }
    }

    /// The reported "every reply is printed twice" bug. Replaying a real
    /// `--stream-partial-output` capture, the text the transcript ends up
    /// with must be each segment exactly once — not the fragments plus the
    /// CLI's consolidated re-send of the same words.
    #[test]
    fn consolidated_assistant_blocks_do_not_double_the_reply() {
        let events = parse_all_with(&fixture("04_partial_output.jsonl"), true);
        // Mirrors `agentSessionStore`'s rule: deltas append to the open
        // block, a whole `Message` replaces it.
        let mut segments: Vec<String> = Vec::new();
        let mut open = false;
        for event in &events {
            match event {
                AgentEvent::MessageDelta { text } => {
                    if open {
                        segments.last_mut().unwrap().push_str(text);
                    } else {
                        segments.push(text.clone());
                        open = true;
                    }
                }
                AgentEvent::Message { text, .. } => {
                    if open {
                        *segments.last_mut().unwrap() = text.clone();
                    } else {
                        segments.push(text.clone());
                    }
                    open = false;
                }
                AgentEvent::ToolCall { .. } | AgentEvent::Thinking { .. } => open = false,
                _ => {}
            }
        }
        assert_eq!(
            segments,
            vec![
                "Checking now.".to_string(),
                "`sample.txt` contained:\n\n```\nhello\n```".to_string(),
            ]
        );
    }

    /// The consolidated copy is what closes each segment, so it has to
    /// arrive as a whole `Message` — that is what lets the transcript
    /// treat it as authoritative instead of appending it.
    #[test]
    fn a_segments_last_assistant_line_is_a_whole_message() {
        let events = parse_all_with(&fixture("04_partial_output.jsonl"), true);
        let whole: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Message { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            whole,
            vec![
                "Checking now.",
                "`sample.txt` contained:\n\n```\nhello\n```"
            ]
        );
    }

    /// Captured against a `permissions.deny` rule: the refusal really is a
    /// `rejected` variant, and it must reach the UI as a permission event
    /// rather than an ordinary error result.
    #[test]
    fn a_rejected_shell_call_becomes_a_permission_event() {
        let events = parse_all(&fixture("05_rejected_shell.jsonl"));
        let denials: Vec<&AgentEvent> = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::PermissionDenied { .. }))
            .collect();
        assert!(!denials.is_empty(), "expected the rejection to be surfaced");
        assert!(matches!(
            denials[0],
            AgentEvent::PermissionDenied { tool_name, message, gated, .. }
                // The CLI leaves `reason` empty, so the message has to
                // explain itself rather than fall back to a placeholder.
                if tool_name == "Bash" && message.contains("cli-config.json") && !*gated
        ));
    }

    /// The old heuristic treated *any* result without a `success` key as a
    /// denial, which turned ordinary tool failures into Approve/Deny cards
    /// captioned "Tool call did not complete successfully."
    #[test]
    fn a_failed_tool_call_is_an_error_not_a_permission_request() {
        let line = r#"{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"nope"},"result":{"error":{"error":"spawn nope ENOENT"}}}}}"#;
        let mut cache = HashMap::new();
        let (events, _) = parse_line(line, &mut cache, false);
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::ToolResult { content, is_error: true, .. }] if content == "spawn nope ENOENT"
        ));
    }

    #[test]
    fn malformed_line_becomes_an_error_event_not_a_panic() {
        let mut cache = HashMap::new();
        let (events, session_id) = parse_line("{not valid json", &mut cache, false);
        assert!(session_id.is_none());
        assert!(matches!(events.as_slice(), [AgentEvent::Error { .. }]));
    }
}
