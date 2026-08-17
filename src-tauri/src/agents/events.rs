use serde::Serialize;

/// Normalized, CLI-agnostic event shape emitted to the frontend on
/// `agent://{run_id}/event`. Only the per-CLI modules under `agents/`
/// (`claude.rs`, `cursor_agent.rs`, `codex.rs`) know the raw wire format
/// for their CLI — everything downstream (the transcript renderer,
/// `agentSessionStore.ts`) only ever sees this enum, per
/// docs/ARCHITECTURE.md §3.4.
// `rename_all` on the enum only renames the variant tags ("ToolResult" ->
// "toolResult"), not the fields of a struct-like variant — every variant
// below needs its own `rename_all` too, or multi-word fields (tool_use_id,
// is_error, ...) serialize as snake_case and every frontend consumer
// silently gets `undefined` for them (see `git.rs::DiffContent`'s comment
// — confirmed via a serde_json round-trip, this is a real serde gotcha,
// not a guess).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    /// A plain text content block from either role. When a turn streamed,
    /// this arrives *after* the deltas that built it and carries the
    /// authoritative full text, so the renderer replaces what it
    /// accumulated rather than appending a second copy (Claude sends both;
    /// see `claude.rs`). CLIs whose streaming replaces the whole-block
    /// event never send this mid-turn at all (Cursor).
    #[serde(rename_all = "camelCase")]
    Message { role: String, text: String },
    /// A fragment of assistant text as the model produces it. Only emitted
    /// for providers whose `capabilities.streaming` is `Deltas`. Coalesced
    /// in `manager.rs` before being emitted — one IPC message per token
    /// would re-render the transcript hundreds of times per response.
    #[serde(rename_all = "camelCase")]
    MessageDelta { text: String },
    /// A `thinking` content block. Signature/redaction payload is dropped
    /// — the UI only ever shows the thinking text, collapsed by default.
    #[serde(rename_all = "camelCase")]
    Thinking { text: String },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        /// Flattened to a display string — tool results can be a bare
        /// string, a content-block array, or (for edit-like tools) a
        /// unified-diff-ish text, depending on tool and CLI; the renderer
        /// only needs something to print in the card.
        content: String,
        is_error: bool,
        /// Edit/write line-change counts, when the CLI provides them (or
        /// the adapter can derive them) — populates the card header's
        /// `+N −M` badge. `None` when not applicable/knowable.
        diff_added: Option<u32>,
        diff_removed: Option<u32>,
    },
    /// A tool call the CLI auto-denied because it wasn't pre-authorized
    /// for this run (see the plan's Step 0 findings — there is no live
    /// approve/deny round-trip in this CLI build; permission is granted
    /// by restarting the session with an updated allow-list). The
    /// frontend renders this as an Approve/Deny card regardless of the
    /// underlying mechanism.
    #[serde(rename_all = "camelCase")]
    PermissionDenied {
        tool_name: String,
        tool_use_id: String,
        /// The tool's original input, so "Approve" can be replayed as a
        /// follow-up instruction without asking the model to reconstruct
        /// it.
        tool_input: serde_json::Value,
        message: String,
    },
    /// The turn was stopped early, on purpose, because a tool needs the
    /// user's approval and the run is in `Manual` mode — see
    /// `manager.rs::run_turn`'s pause branch. Emitted *instead of* letting
    /// the CLI carry on past its own inline auto-denial, which is what
    /// made "Manual" feel like it asked and then ignored the answer.
    /// Always followed by an `Exit`; the frontend uses this to tell a
    /// deliberate pause apart from a mid-turn crash.
    #[serde(rename_all = "camelCase")]
    AwaitingPermission { tool_use_id: String },
    /// The final `result` event for a turn.
    #[serde(rename_all = "camelCase")]
    TurnResult {
        session_id: String,
        is_error: bool,
        total_cost_usd: Option<f64>,
        duration_ms: u64,
        num_turns: u32,
        /// Normalized usage reported by the CLI for this turn. These are
        /// optional because older CLI builds (and a few legacy event
        /// shapes) do not expose every counter.
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        /// The model's context window, when the CLI reports it. Turns raw
        /// token counts into the number that actually predicts a
        /// compaction. `None` unless `capabilities.reports_context_window`.
        context_window: Option<u64>,
        result_text: Option<String>,
    },
    /// stderr output or a spawn-level failure.
    #[serde(rename_all = "camelCase")]
    Error { message: String },
    /// The child process exited.
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<i32> },
    /// Anything we didn't recognize — forwarded verbatim rather than
    /// silently dropped, per docs/CHECKLIST.md's "no silent failure".
    #[serde(rename_all = "camelCase")]
    Raw { json: serde_json::Value },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the gotcha in this module's header: enum-level `rename_all`
    /// does *not* cascade into a struct-like variant's fields, so a
    /// variant missing its own attribute ships snake_case keys and every
    /// frontend consumer silently reads `undefined`. Asserting the wire
    /// shape catches that at test time instead of in the UI.
    #[test]
    fn multi_word_fields_serialize_as_camel_case() {
        let json = serde_json::to_value(AgentEvent::AwaitingPermission {
            tool_use_id: "toolu_1".to_string(),
        })
        .unwrap();
        assert_eq!(json["type"], "awaitingPermission");
        assert_eq!(json["toolUseId"], "toolu_1");

        let json = serde_json::to_value(AgentEvent::TurnResult {
            session_id: "sess".to_string(),
            is_error: false,
            total_cost_usd: Some(0.5),
            duration_ms: 10,
            num_turns: 1,
            input_tokens: Some(4),
            output_tokens: Some(186),
            cache_read_tokens: Some(42014),
            cache_write_tokens: None,
            context_window: Some(1_000_000),
            result_text: None,
        })
        .unwrap();
        assert_eq!(json["type"], "turnResult");
        assert_eq!(json["inputTokens"], 4);
        assert_eq!(json["outputTokens"], 186);
        assert_eq!(json["cacheReadTokens"], 42014);
        assert!(json["cacheWriteTokens"].is_null());
        assert_eq!(json["contextWindow"], 1_000_000);
    }
}
