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
    /// A plain text content block from either role.
    #[serde(rename_all = "camelCase")]
    Message { role: String, text: String },
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
    /// The final `result` event for a turn.
    #[serde(rename_all = "camelCase")]
    TurnResult {
        session_id: String,
        is_error: bool,
        total_cost_usd: Option<f64>,
        duration_ms: u64,
        num_turns: u32,
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
