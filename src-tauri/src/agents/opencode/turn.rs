//! OpenCode's turn path: `run --format json` against the managed sidecar
//! (docs/OPENCODE_INTEGRATION.md §1.2), parsed per the Phase O1 fixtures
//! in `tests/fixtures/opencode/`.
//!
//! Everything here was written against captured output, not documentation
//! — the envelope is `{type, timestamp, sessionID, part}` with event types
//! `step_start | text | reasoning | tool_use | step_finish`, text and
//! reasoning arrive only as finished blocks (`Streaming::Blocks`), tool
//! parts arrive once with terminal state, and a denied permission
//! terminates the run with the model never re-consulted. The fixture
//! replay tests at the bottom are the executable form of that sentence.

use crate::agents::adapter::{PermissionMode, ToolUseCache, TurnCtx, TurnSpawn};
use crate::agents::events::AgentEvent;
use crate::process_ext::{resolve_executable, HiddenCommandExt};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::process::Command;

/// Reserved key under which the per-step usage totals are accumulated in
/// the per-turn `ToolUseCache` — one user-visible turn spans several
/// `step_finish` events (one per model round trip), and the `TurnResult`
/// is synthesized from their sum once the stream ends.
const USAGE_KEY: &str = "\0opencode.usage";

/// Reserved key counting `step_finish` events — the closest thing this
/// CLI has to "round trips".
const STEPS_KEY: &str = "\0opencode.steps";

pub fn build_turn(ctx: &TurnCtx, text: &str) -> TurnSpawn {
    let mut cmd = Command::new(resolve_executable(ctx.binary_path));
    cmd.hide_window();
    cmd.arg("run").arg("--format").arg("json");

    // Attach to Maestro's sidecar when it's up: one warm server shared
    // across turns instead of a cold boot per message. `--dir` is not
    // optional in attach mode — there it means "path on the remote
    // server", and the worktree root is exactly what we want (verified,
    // fixture 06). Unattached runs pick up the working directory.
    if let Some(endpoint) = ctx.attach {
        cmd.arg("--attach")
            .arg(format!("http://127.0.0.1:{}", endpoint.port))
            // Environment, never argv... except this is opencode's own
            // flag for its client-to-server auth, and there is no env
            // alternative on `run`. The password protects the sidecar
            // from *other* processes; here it travels in our child's
            // argv, readable only by same-user processes — the same
            // exposure class as every other CLI flag Maestro passes.
            .arg("-p")
            .arg(&endpoint.password)
            .arg("--dir")
            .arg(ctx.worktree_root);
    }

    if let Some(model) = ctx.model {
        cmd.arg("-m").arg(model);
    }
    if let Some(variant) = ctx.effort {
        // opencode calls reasoning effort "variant" and takes it as its
        // own flag; nothing is baked into the model id.
        cmd.arg("--variant").arg(variant);
    }

    match ctx.permission_mode {
        // A real read-only agent ships built in.
        PermissionMode::Plan => {
            cmd.arg("--agent").arg("plan");
        }
        // Auto-approve everything not explicitly denied. Manual mode
        // passes nothing: approval policy is the project's opencode.json
        // (capabilities.rs says so out loud), and a denied tool ends the
        // run with a surfaced rejection rather than a question nobody can
        // answer.
        PermissionMode::Auto => {
            cmd.arg("--auto");
        }
        PermissionMode::Manual => {}
    }

    if let Some(session_id) = ctx.resume_session_id {
        cmd.arg("--session").arg(session_id);
        if ctx.fork_session {
            // Branch instead of append — requires --session/-c, which is
            // exactly the guard above.
            cmd.arg("--fork");
        }
    }

    // Reasoning sections are emitted only with this flag; without it the
    // transcript silently loses every thinking block.
    cmd.arg("--thinking");

    cmd.arg(text);

    cmd.current_dir(ctx.worktree_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    TurnSpawn {
        command: cmd,
        stdin_payload: None,
        assigned_session_id: None,
    }
}

/// opencode tool names → the card set `ToolCallCard` renders. Most map to
/// their capitalized selves; the aliases keep odd spellings from falling
/// into the generic case.
fn normalize_tool_name(raw: &str) -> String {
    match raw {
        "todowrite" => "TodoWrite".to_string(),
        "todoread" => "TodoRead".to_string(),
        "webfetch" => "WebFetch".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => other.to_string(),
            }
        }
    }
}

fn as_u32(value: Option<&Value>) -> Option<u32> {
    value.and_then(|v| v.as_u64()).map(|n| n as u32)
}

/// One `tool_use` part → a call/result pair. Arrives with terminal state
/// only (no pending/running transitions in run mode), so both halves are
/// emitted together.
fn tool_events(part: &Value) -> Vec<AgentEvent> {
    let name = part
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let call_id = part
        .get("callID")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let state = part.get("state").cloned().unwrap_or(json!({}));
    let input = state.get("input").cloned().unwrap_or(json!({}));
    let status = state.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let normalized = normalize_tool_name(name);

    let mut events = vec![AgentEvent::ToolCall {
        id: call_id.clone(),
        name: normalized.clone(),
        input: input.clone(),
    }];

    let is_error = status == "error";
    let error_text = state
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let output_text = state
        .get("output")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    events.push(AgentEvent::ToolResult {
        tool_use_id: call_id.clone(),
        content: if is_error && output_text.is_empty() {
            error_text.clone()
        } else {
            output_text
        },
        is_error,
        diff_added: as_u32(state.pointer("/metadata/diffAdded")),
        diff_removed: as_u32(state.pointer("/metadata/diffRemoved")),
    });

    // A permission refusal is a specific kind of error with specific UX:
    // the transcript shows an approvable-looking denial card (gated is
    // false — nothing is waiting; the run already terminated, fixture 04)
    // instead of burying the reason in a failed Bash card.
    if is_error && error_text.contains("rejected permission") {
        events.push(AgentEvent::PermissionDenied {
            tool_name: normalized,
            tool_use_id: call_id,
            tool_input: input,
            message: error_text,
            gated: false,
        });
    }

    events
}

struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost: f64,
}

fn load_usage(cache: &ToolUseCache) -> Usage {
    cache
        .get(USAGE_KEY)
        .and_then(|(_, v)| v.as_object())
        .map(|v| Usage {
            input: v.get("input").and_then(|x| x.as_u64()).unwrap_or(0),
            output: v.get("output").and_then(|x| x.as_u64()).unwrap_or(0),
            cache_read: v.get("cacheRead").and_then(|x| x.as_u64()).unwrap_or(0),
            cache_write: v.get("cacheWrite").and_then(|x| x.as_u64()).unwrap_or(0),
            cost: v.get("cost").and_then(|x| x.as_f64()).unwrap_or(0.0),
        })
        .unwrap_or(Usage {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            cost: 0.0,
        })
}

fn accumulate_usage(cache: &mut ToolUseCache, part: &Value) {
    let tokens = part.get("tokens").cloned().unwrap_or(json!({}));
    let cache_tokens = tokens.get("cache").cloned().unwrap_or(json!({}));
    let mut usage = load_usage(cache);
    usage.input += tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
    usage.output += tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
    usage.cache_read += cache_tokens
        .get("read")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    usage.cache_write += cache_tokens
        .get("write")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    // Per-step cost summed across the turn's round trips — each
    // step_finish carries its own message's spend (fixture 01's two steps
    // are two separate messages).
    usage.cost += part.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    cache.insert(
        USAGE_KEY.to_string(),
        (
            String::new(),
            json!({
                "input": usage.input,
                "output": usage.output,
                "cacheRead": usage.cache_read,
                "cacheWrite": usage.cache_write,
                "cost": usage.cost,
            }),
        ),
    );
    let steps = cache
        .get(STEPS_KEY)
        .and_then(|(_, v)| v.as_u64())
        .unwrap_or(0);
    cache.insert(STEPS_KEY.to_string(), (String::new(), json!(steps + 1)));
}

pub fn parse_line(
    line: &str,
    cache: &mut ToolUseCache,
    _stream_deltas: bool,
) -> (Vec<AgentEvent>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        // Manager already re-joined split JSON lines before calling here;
        // whatever survives that and still isn't JSON isn't ours.
        return (Vec::new(), None);
    };
    let Some(event_type) = value.get("type").and_then(|v| v.as_str()) else {
        return (Vec::new(), None);
    };
    let session_id = value
        .get("sessionID")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let part = value.get("part").cloned().unwrap_or(json!({}));

    let events = match event_type {
        // Finished blocks only (Streaming::Blocks) — this IS the full
        // text, not something deltas will later replace.
        "text" => vec![AgentEvent::Message {
            role: "assistant".to_string(),
            text: part
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }],
        "reasoning" => vec![AgentEvent::Thinking {
            text: part
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }],
        "tool_use" => tool_events(&part),
        "step_finish" => {
            accumulate_usage(cache, &part);
            Vec::new()
        }
        // Bookkeeping with no transcript presence today.
        "step_start" => Vec::new(),
        // No silent failure: forward shapes we don't recognize verbatim.
        _ => vec![AgentEvent::Raw { json: value }],
    };

    (events, session_id)
}

/// Synthesizes the turn's closing `TurnResult` from accumulated
/// `step_finish` totals — opencode has no single final result line; its
/// last step (reason "stop") just… stops.
pub fn finish(
    cache: &ToolUseCache,
    session_id: &str,
    duration_ms: u64,
    interrupted: bool,
) -> Vec<AgentEvent> {
    let usage = load_usage(cache);
    let steps = cache
        .get(STEPS_KEY)
        .and_then(|(_, v)| v.as_u64())
        .unwrap_or(0);
    // Stopping a turn deliberately is normal, not a failure (aider's
    // precedent). A turn that never reached the model did not do what was
    // asked, though.
    let reached_model = steps > 0 || interrupted;
    // A completed turn's numbers are authoritative even when zero — a
    // free model genuinely costs $0.00, and hiding that would read as
    // "unknown". Only a turn that never got there reports nothing.
    let (cost, input, output, cache_read, cache_write) = if steps > 0 {
        (
            Some(usage.cost),
            Some(usage.input),
            Some(usage.output),
            Some(usage.cache_read),
            Some(usage.cache_write),
        )
    } else {
        (None, None, None, None, None)
    };
    vec![AgentEvent::TurnResult {
        session_id: session_id.to_string(),
        is_error: !reached_model,
        total_cost_usd: cost,
        duration_ms,
        num_turns: steps as u32,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        context_window: None,
        result_text: if reached_model {
            None
        } else {
            Some(
                "OpenCode ended without a reply from the model. Check the connected provider in Settings → Agents."
                    .to_string(),
            )
        },
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with(attach: Option<&crate::agents::opencode::client::Endpoint>) -> TurnCtx<'_> {
        TurnCtx {
            binary_path: "opencode",
            worktree_root: "/tmp/worktree",
            resume_session_id: None,
            fork_session: false,
            allowed_tools: &[],
            model: None,
            effort: None,
            fast: false,
            permission_mode: PermissionMode::Manual,
            stream_deltas: false,
            extra_env: &[],
            session_dir: std::path::Path::new("/tmp"),
            attach,
        }
    }

    fn args_of(spawn: TurnSpawn) -> Vec<String> {
        spawn
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn plain_turn_is_json_format_with_thinking() {
        let args = args_of(build_turn(&ctx_with(None), "hi"));
        for flag in ["run", "--format", "json", "--thinking", "hi"] {
            assert!(
                args.contains(&flag.to_string()),
                "missing {flag} in {args:?}"
            );
        }
        assert!(!args.contains(&"--auto".to_string()));
        assert!(!args.iter().any(|a| a.contains("attach")));
    }

    #[test]
    fn attach_mode_carries_url_password_and_dir() {
        let endpoint = crate::agents::opencode::client::Endpoint {
            port: 4096,
            password: "secret-pw".to_string(),
        };
        let args = args_of(build_turn(&ctx_with(Some(&endpoint)), "hi"));
        let attach_at = args.iter().position(|a| a == "--attach").unwrap();
        assert_eq!(args[attach_at + 1], "http://127.0.0.1:4096");
        // The sidecar password must be present for the client handshake…
        assert!(args.contains(&"secret-pw".to_string()));
        // …and --dir must point at the worktree (attach-mode cwd rule).
        let dir_at = args.iter().position(|a| a == "--dir").unwrap();
        assert_eq!(args[dir_at + 1], "/tmp/worktree");
    }

    #[test]
    fn plan_auto_model_and_variant_map_to_their_flags() {
        let mut ctx = ctx_with(None);
        ctx.permission_mode = PermissionMode::Plan;
        ctx.model = Some("opencode/big-pickle");
        ctx.effort = Some("high");
        let args = args_of(build_turn(&ctx, "hi"));
        let agent_at = args.iter().position(|a| a == "--agent").unwrap();
        assert_eq!(args[agent_at + 1], "plan");
        assert!(args.contains(&"-m".to_string()));
        assert!(args.contains(&"opencode/big-pickle".to_string()));
        let variant_at = args.iter().position(|a| a == "--variant").unwrap();
        assert_eq!(args[variant_at + 1], "high");

        let mut auto_ctx = ctx_with(None);
        auto_ctx.permission_mode = PermissionMode::Auto;
        assert!(args_of(build_turn(&auto_ctx, "hi")).contains(&"--auto".to_string()));
    }

    #[test]
    fn fork_requires_session_and_travels_with_it() {
        let mut ctx = ctx_with(None);
        ctx.resume_session_id = Some("ses_123");
        ctx.fork_session = true;
        let args = args_of(build_turn(&ctx, "hi"));
        let session_at = args.iter().position(|a| a == "--session").unwrap();
        assert_eq!(args[session_at + 1], "ses_123");
        assert!(args.contains(&"--fork".to_string()));

        // Forking without a session id is invalid per --help; the adapter
        // must simply drop it rather than produce a failing command.
        let mut orphan = ctx_with(None);
        orphan.fork_session = true;
        assert!(!args_of(build_turn(&orphan, "hi")).contains(&"--fork".to_string()));
    }

    /// Replays a whole captured stdout through the parser the way
    /// `manager.rs` does, returning reconstructed assistant text, the
    /// non-text events, and the closing TurnResult.
    fn replay(fixture: &str) -> (String, Vec<AgentEvent>, Vec<AgentEvent>) {
        let raw = std::fs::read_to_string(format!(
            "{}/tests/fixtures/opencode/{fixture}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("fixture missing");

        let mut cache = ToolUseCache::new();
        let mut text = String::new();
        let mut others = Vec::new();
        let mut session_id: Option<String> = None;
        for line in raw.lines() {
            let (events, learned) = parse_line(line, &mut cache, false);
            if learned.is_some() {
                session_id = learned;
            }
            for event in events {
                match event {
                    AgentEvent::Message { text: block, .. } => text.push_str(&block),
                    other => others.push(other),
                }
            }
        }
        let finished = finish(&cache, session_id.as_deref().unwrap_or(""), 4_200, false);
        (text, others, finished)
    }

    #[test]
    fn tool_turn_reconstructs_cards_and_usage() {
        let (text, others, finished) = replay("01_tool_turn.jsonl");

        // The model's reply arrives whole, with no chrome around it.
        assert!(
            text.contains("Done. The command ran successfully."),
            "{text}"
        );

        // One bash round trip → one call/result pair, terminal state.
        let calls: Vec<_> = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall { name, input, .. } => Some((name.clone(), input.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "Bash");
        assert_eq!(calls[0].1["command"], "echo mock-tool-ran");

        let results: Vec<_> = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolResult {
                    content, is_error, ..
                } => Some((content.clone(), *is_error)),
                _ => None,
            })
            .collect();
        assert_eq!(results, vec![("mock-tool-ran\n".to_string(), false)]);

        // Both steps' tokens sum into one result (900+400 in, 60+260 out,
        // 800 cache read), two round trips, session id carried through.
        match &finished[0] {
            AgentEvent::TurnResult {
                session_id,
                num_turns,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                is_error,
                ..
            } => {
                assert!(session_id.starts_with("ses_"), "{session_id}");
                assert_eq!(*num_turns, 2);
                assert_eq!(*input_tokens, Some(1_300));
                assert_eq!(*output_tokens, Some(320));
                assert_eq!(*cache_read_tokens, Some(800));
                assert!(!is_error);
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn text_turn_yields_one_message_and_usage() {
        let (text, others, finished) = replay("02_text_turn.jsonl");
        assert_eq!(text, "Hello from the mock model.");
        assert!(others.is_empty(), "{others:?}");
        match &finished[0] {
            AgentEvent::TurnResult {
                input_tokens,
                output_tokens,
                num_turns,
                total_cost_usd,
                ..
            } => {
                assert_eq!(*input_tokens, Some(100));
                assert_eq!(*output_tokens, Some(20));
                assert_eq!(*num_turns, 1);
                // The mock prices this at zero and the turn ran — $0.00
                // is the true figure, so it ships as Some(0.0), not a
                // None that would read as "unknown".
                assert_eq!(*total_cost_usd, Some(0.0));
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_becomes_a_thinking_block_separate_from_the_answer() {
        let (text, others, _) = replay("03_reasoning_turn.jsonl");
        let thinking: Vec<&String> = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Thinking { text } => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(thinking.len(), 1, "{others:?}");
        assert!(thinking[0].contains("We need"));
        assert!(text.contains("Hello from the mock model."));
        assert!(
            !text.contains("We need"),
            "reasoning leaked into the answer"
        );
    }

    #[test]
    fn permission_denial_surfaces_as_a_denial_card_and_error_result() {
        let (_text, others, finished) = replay("04_permission_denied.jsonl");

        let denials: Vec<_> = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::PermissionDenied {
                    tool_name,
                    gated,
                    message,
                    ..
                } => Some((tool_name.clone(), *gated, message.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(denials.len(), 1);
        assert_eq!(denials[0].0, "Bash");
        assert!(!denials[0].1, "nothing is waiting — the run already ended");
        assert!(denials[0].2.contains("rejected permission"));

        // The failed tool result is still a failed tool result, carrying
        // the rejection message as its content.
        assert!(others.iter().any(|e| matches!(
            e,
            AgentEvent::ToolResult { is_error: true, content, .. }
                if content.contains("rejected permission")
        )));

        // The turn itself completed from the stream's perspective.
        match &finished[0] {
            AgentEvent::TurnResult {
                is_error,
                num_turns,
                ..
            } => {
                assert!(!is_error);
                assert_eq!(*num_turns, 1);
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn auto_approved_tool_runs_clean() {
        let (_text, others, _) = replay("05_permission_auto.jsonl");
        assert!(
            others.iter().any(|e| matches!(
                e,
                AgentEvent::ToolResult { is_error: false, content, .. }
                    if content.contains("mock-tool-ran")
            )),
            "{others:?}"
        );
        assert!(!others
            .iter()
            .any(|e| matches!(e, AgentEvent::PermissionDenied { .. })));
    }

    #[test]
    fn attached_runs_parse_identically() {
        let (text, others, finished) = replay("06_attach_turn.jsonl");
        assert!(text.contains("Done."));
        assert_eq!(
            others
                .iter()
                .filter(|e| matches!(e, AgentEvent::ToolCall { .. }))
                .count(),
            1
        );
        assert!(matches!(
            &finished[0],
            AgentEvent::TurnResult {
                is_error: false,
                ..
            }
        ));
    }

    #[test]
    fn a_real_zen_turn_through_the_attach_path_parses() {
        // Captured live against opencode/big-pickle via `run --attach`
        // (Phase O5's exit check — free model, real provider, real
        // sidecar). The model wrote a file and replied "DONE".
        let (text, others, finished) = replay("07_real_zen_turn.jsonl");

        assert!(text.contains("DONE"), "{text}");
        let thinking = others
            .iter()
            .filter(|e| matches!(e, AgentEvent::Thinking { .. }))
            .count();
        assert!(thinking >= 1, "real reasoning models emit thinking blocks");

        let writes = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(writes, vec!["Write"]);

        match &finished[0] {
            AgentEvent::TurnResult {
                is_error,
                num_turns,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                total_cost_usd,
                ..
            } => {
                assert!(!is_error);
                assert_eq!(*num_turns, 2);
                assert_eq!(*input_tokens, Some(4104 + 4228));
                assert_eq!(*output_tokens, Some(124 + 3));
                assert_eq!(*cache_read_tokens, Some(7296 + 7360));
                // big-pickle is priced at zero; the true figure ships.
                assert_eq!(*total_cost_usd, Some(0.0));
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn garbage_lines_are_ignored_not_fatal() {
        let mut cache = ToolUseCache::new();
        for line in ["not json at all", "{\"type\":", ""] {
            let (events, session) = parse_line(line, &mut cache, false);
            assert!(events.is_empty());
            assert!(session.is_none());
        }
    }

    #[test]
    fn unrecognized_event_types_forward_verbatim() {
        let mut cache = ToolUseCache::new();
        let raw = r#"{"type":"something-new","sessionID":"ses_x","part":{"weird":true}}"#;
        let (events, _) = parse_line(raw, &mut cache, false);
        match &events[0] {
            AgentEvent::Raw { json } => assert_eq!(json["type"], "something-new"),
            other => panic!("expected a raw event, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_turn_closes_out_as_failed() {
        // No step ever finished — nothing reached the model.
        let events = finish(&ToolUseCache::new(), "sess", 10, false);
        match &events[0] {
            AgentEvent::TurnResult {
                is_error,
                result_text,
                ..
            } => {
                assert!(*is_error);
                assert!(result_text.is_some());
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }
}
