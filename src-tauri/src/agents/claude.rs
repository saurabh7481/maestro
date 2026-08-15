//! Claude Code adapter — the first CLI wrapped (docs/ROADMAP.md Phase 5),
//! now one of three under the shared dispatch in `adapter.rs` (Phase 6).
//!
//! ## Findings from the live protocol spike (Phase 5's plan `Step 0`)
//!
//! The installed CLI (2.1.223) has **no `--permission-prompt-tool`** flag
//! (docs/ARCHITECTURE.md's assumption was stale) and, confirmed by
//! actually running it against a scratch repo:
//! - `--permission-mode manual --allowedTools "Read Grep"` etc. gates
//!   every tool not in the allow-list.
//! - A gated tool call is **auto-denied inline** — no live approve/deny
//!   round-trip exists. The denial appears as a
//!   `{"type":"system","subtype":"permission_denied","tool_name",
//!   "tool_use_id","message"}` event immediately followed by a synthetic
//!   `tool_result` (`is_error:true`) that the model sees and responds to
//!   in the same turn.
//! - `--resume <session_id>` with an **updated** `--allowedTools` on a
//!   fresh spawn is how a previously-denied action actually gets to run —
//!   verified end-to-end: denied on turn 1, re-spawned with `--resume` +
//!   the tool added to `--allowedTools`, succeeded on turn 2, same
//!   `session_id` throughout.
//!
//! This is why `manager.rs::run_turn` spawns fresh per turn (`--resume`
//! chains them) instead of keeping one process's stdin open across turns
//! — the CLI's own on-disk session persistence carries continuity.
//! "Approve"/"Deny" (`manager.rs::respond_to_permission`) are both just
//! another turn: Approve widens `allowed_tools` first, Deny doesn't.
//!
//! Fixture lines captured during the spike live under
//! `src-tauri/tests/fixtures/claude/`.

use crate::agents::adapter::{PermissionMode, ToolUseCache, TurnCtx, TurnSpawn};
use crate::agents::events::AgentEvent;
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;

/// Pre-authorized on every run so basic exploration doesn't need a
/// round-trip through the permission UI — anything that can mutate the
/// worktree or run arbitrary commands still gates through
/// `PermissionDenied`.
pub const DEFAULT_ALLOWED_TOOLS: &[&str] = &["Read", "Grep", "Glob"];

pub fn build_turn(ctx: &TurnCtx, text: &str) -> TurnSpawn {
    let mut cmd = Command::new(ctx.binary_path);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]);
    match ctx.permission_mode {
        PermissionMode::Auto => {
            cmd.args(["--permission-mode", "bypassPermissions"]);
        }
        PermissionMode::Plan => {
            cmd.args(["--permission-mode", "plan"]);
        }
        PermissionMode::Manual => {
            cmd.args(["--permission-mode", "manual"]);
            if !ctx.allowed_tools.is_empty() {
                cmd.arg("--allowedTools").arg(ctx.allowed_tools.join(" "));
            }
        }
    }
    if let Some(id) = ctx.resume_session_id {
        cmd.arg("--resume").arg(id);
        if ctx.fork_session {
            cmd.arg("--fork-session");
        }
    }
    if let Some(model) = ctx.model {
        cmd.arg("--model").arg(model);
    }
    cmd.current_dir(ctx.worktree_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let stdin_payload = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    })
    .to_string();

    TurnSpawn {
        command: cmd,
        stdin_payload: Some(stdin_payload),
    }
}

/// Naive whole-block diff (old_string entirely removed, new_string
/// entirely added) — good enough for a `+N −M` badge and a readable
/// diff-ish preview; not a real line-diff algorithm. Only Claude's Edit
/// tool gives us `old_string`/`new_string` directly like this — Cursor's
/// equivalent tool reports real added/removed counts itself (see
/// `cursor_agent.rs`), so this is Claude-specific, not shared.
fn edit_diff(input: &Value) -> Option<(String, u32, u32)> {
    let old = input.get("old_string")?.as_str()?;
    let new = input.get("new_string")?.as_str()?;
    let removed = old.lines().count() as u32;
    let added = new.lines().count() as u32;
    let mut text = String::new();
    for line in old.lines() {
        text.push_str("- ");
        text.push_str(line);
        text.push('\n');
    }
    for line in new.lines() {
        text.push_str("+ ");
        text.push_str(line);
        text.push('\n');
    }
    Some((text, added, removed))
}

/// One NDJSON line → zero or more normalized events, plus a
/// just-learned session id when this was the `system/init` line. Unknown
/// `(type, subtype)` pairs outside `KNOWN_NOISE` forward as `Raw` rather
/// than being dropped — see docs/CHECKLIST.md's "no silent failure".
///
/// `tool_use_cache` correlates a later `permission_denied` event (which
/// carries no `input`) back to the `tool_use` block that requested it
/// (which does) — confirmed necessary by the spike, see the module doc.
pub fn parse_line(
    line: &str,
    tool_use_cache: &mut ToolUseCache,
) -> (Vec<AgentEvent>, Option<String>) {
    const KNOWN_NOISE: &[(&str, &str)] = &[
        ("system", "hook_started"),
        ("system", "hook_response"),
        ("system", "thinking_tokens"),
        ("rate_limit_event", ""),
    ];

    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return (
            vec![AgentEvent::Error {
                message: format!("Malformed JSON line from claude: {line}"),
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
        "system" if subtype == "permission_denied" => {
            let tool_use_id = value
                .get("tool_use_id")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let tool_name = value
                .get("tool_name")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let message = value
                .get("message")
                .and_then(|s| s.as_str())
                .unwrap_or("Permission required.")
                .to_string();
            let tool_input = tool_use_cache
                .get(&tool_use_id)
                .map(|(_, input)| input.clone())
                .unwrap_or(Value::Null);
            (
                vec![AgentEvent::PermissionDenied {
                    tool_name,
                    tool_use_id,
                    tool_input,
                    message,
                }],
                None,
            )
        }
        "assistant" => {
            let blocks = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            let mut events = Vec::new();
            for block in blocks {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                events.push(AgentEvent::Message {
                                    role: "assistant".to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    Some("thinking") => {
                        if let Some(text) = block.get("thinking").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                events.push(AgentEvent::Thinking {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(|t| t.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|t| t.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        tool_use_cache.insert(id.clone(), (name.clone(), input.clone()));
                        events.push(AgentEvent::ToolCall { id, name, input });
                    }
                    _ => {}
                }
            }
            (events, None)
        }
        "user" => {
            let blocks = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            let mut events = Vec::new();
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string();
                let is_error = block
                    .get("is_error")
                    .and_then(|t| t.as_bool())
                    .unwrap_or(false);
                let mut content = match block.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(blocks)) => blocks
                        .iter()
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                let mut diff_added = None;
                let mut diff_removed = None;
                if let Some((name, input)) = tool_use_cache.get(&tool_use_id) {
                    if name == "Edit" {
                        if let Some((diff_text, added, removed)) = edit_diff(input) {
                            content = diff_text;
                            diff_added = Some(added);
                            diff_removed = Some(removed);
                        }
                    }
                }
                events.push(AgentEvent::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                    diff_added,
                    diff_removed,
                });
            }
            (events, None)
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
                        .unwrap_or(false),
                    total_cost_usd: value.get("total_cost_usd").and_then(|n| n.as_f64()),
                    duration_ms: value
                        .get("duration_ms")
                        .and_then(|n| n.as_u64())
                        .unwrap_or(0),
                    num_turns: value.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                    result_text: value
                        .get("result")
                        .and_then(|s| s.as_str())
                        .map(str::to_string),
                }],
                None,
            )
        }
        other => {
            if KNOWN_NOISE.contains(&(other, subtype)) {
                (Vec::new(), None)
            } else {
                (vec![AgentEvent::Raw { json: value }], None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/tests/fixtures/claude/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        fs::read_to_string(path).unwrap()
    }

    fn parse_all(text: &str) -> Vec<AgentEvent> {
        let mut cache = HashMap::new();
        let mut events = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let (mut line_events, _) = parse_line(line, &mut cache);
            events.append(&mut line_events);
        }
        events
    }

    #[test]
    fn parses_simple_no_tool_reply() {
        let events = parse_all(&fixture("01_simple_no_tool.jsonl"));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Message { text, .. } if text == "PONG")));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnResult { .. })));
    }

    #[test]
    fn parses_allowed_tool_use_and_result() {
        let events = parse_all(&fixture("02_tool_use_allowed.jsonl"));
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
    fn parses_denied_tool_use_with_correlated_input() {
        let events = parse_all(&fixture("03_tool_use_denied.jsonl"));
        let denial = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::PermissionDenied {
                    tool_name,
                    tool_input,
                    ..
                } => Some((tool_name, tool_input)),
                _ => None,
            })
            .expect("expected a PermissionDenied event");
        assert_eq!(denial.0, "Write");
        assert!(
            denial.1.get("file_path").is_some(),
            "tool_input should be correlated from the preceding tool_use block"
        );
    }

    #[test]
    fn malformed_line_becomes_an_error_event_not_a_panic() {
        let mut cache = HashMap::new();
        let (events, session_id) = parse_line("{not valid json", &mut cache);
        assert!(session_id.is_none());
        assert!(matches!(events.as_slice(), [AgentEvent::Error { .. }]));
    }

    #[test]
    fn unknown_type_forwards_as_raw_instead_of_dropping() {
        let mut cache = HashMap::new();
        let (events, _) = parse_line(
            r#"{"type":"totally_new_event_type","foo":"bar"}"#,
            &mut cache,
        );
        assert!(matches!(events.as_slice(), [AgentEvent::Raw { .. }]));
    }

    #[test]
    fn resume_after_allow_fixture_parses_without_error_events() {
        let events = parse_all(&fixture("04_resume_after_allow.jsonl"));
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolResult {
                is_error: false,
                ..
            }
        )));
    }
}
