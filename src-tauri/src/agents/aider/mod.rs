//! Aider adapter.
//!
//! ## How this one differs from the other three
//!
//! Claude Code, Cursor Agent and Codex all speak a JSON event stream.
//! Aider has no structured output mode at all — `aider --help` (0.86.2)
//! contains no JSON option — so this adapter parses the same prose a human
//! sees in the terminal. Everything below is written against output
//! captured from a real `aider 0.86.2` run rather than from documentation;
//! `--no-pretty` is what makes that tractable, since it turns off the
//! live-repainting ANSI output that would otherwise interleave escape
//! sequences with the text.
//!
//! ## Sessions
//!
//! Aider has no session ids and no `--resume`. What it has is
//! `--chat-history-file` plus `--restore-chat-history`, which is enough to
//! rebuild the conversation on the next process. Since `manager.rs` spawns
//! a fresh child per turn, *this is not optional*: without it every turn
//! after the first would start with no memory of the conversation.
//! Verified: an identical prompt costs 774 prompt tokens without the flag
//! and 916 with it, i.e. the history really is being replayed.
//!
//! So Maestro mints the session id itself and owns the history file. That
//! is also what makes `resume`/`fork_session` honest capabilities for a
//! CLI that has neither — forking a session is copying a file.
//!
//! ## Keeping the worktree clean
//!
//! Aider writes several dotfiles into the directory it runs in. Three can
//! be relocated with flags (`--chat-history-file`, `--input-history-file`,
//! `--llm-history-file`) and are pointed at Maestro's own session
//! directory. One cannot: `.aider.tags.cache.v4/`, the repo-map cache.
//! Rather than leave it showing as an untracked directory in Maestro's SCM
//! pane forever, `ensure_worktree_exclusions` adds it to the worktree's
//! `.git/info/exclude` — a local, uncommitted ignore, so the user's own
//! `.gitignore` is never modified. `--no-gitignore` stops Aider from
//! editing that file itself, which it otherwise does on first run.

pub mod catalog;
pub mod credentials;
pub mod providers;

use crate::agents::adapter::{PermissionMode, ToolUseCache, TurnCtx, TurnSpawn};
use crate::agents::events::AgentEvent;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

/// Reserved key under which the running usage totals for a turn are kept
/// in the per-turn `ToolUseCache`. Aider prints a `Tokens:`/`Cost:` line
/// after *every* LLM round trip, and one user-visible turn can contain
/// several (observed: two, when Aider re-sends after reading a file), so
/// the numbers are accumulated here and emitted once by `finish`.
const USAGE_KEY: &str = "\0aider.usage";

/// Reserved key holding the last error Aider reported this turn, so
/// `finish` can explain a failure in Aider's own words rather than
/// Maestro's guess.
const ERROR_KEY: &str = "\0aider.error";

/// Reserved key for the parser's position in Aider's output — see
/// `Mode`.
const MODE_KEY: &str = "\0aider.mode";

/// Reserved key for reasoning text accumulated within one THINKING
/// section.
const THINKING_KEY: &str = "\0aider.thinking";

/// The markers Aider wraps a reasoning model's `<think>` block in, taken
/// verbatim from its `reasoning_tags.py` (`REASONING_START` /
/// `REASONING_END`). The `--------------` rules that precede each are
/// already dropped as horizontal rules by `is_banner`.
const THINKING_MARKER: &str = "\u{25ba} **THINKING**";
const ANSWER_MARKER: &str = "\u{25ba} **ANSWER**";

/// Where the parser is in Aider's output. Aider's stream is not
/// self-describing — the same line means different things depending on
/// what preceded it — so a little state is unavoidable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Inside the startup announcement, which ends at the first blank line.
    Banner,
    /// The model talking.
    Prose,
    /// Inside a reasoning section.
    Thinking,
}

fn load_mode(cache: &ToolUseCache) -> Mode {
    match cache.get(MODE_KEY).and_then(|(_, v)| v.as_str()) {
        Some("banner") => Mode::Banner,
        Some("thinking") => Mode::Thinking,
        _ => Mode::Prose,
    }
}

fn store_mode(cache: &mut ToolUseCache, mode: Mode) {
    let value = match mode {
        Mode::Banner => "banner",
        Mode::Prose => "prose",
        Mode::Thinking => "thinking",
    };
    cache.insert(
        MODE_KEY.to_string(),
        (String::new(), Value::String(value.to_string())),
    );
}

fn push_thinking(cache: &mut ToolUseCache, line: &str) {
    let mut buffer = cache
        .get(THINKING_KEY)
        .and_then(|(_, v)| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !buffer.is_empty() {
        buffer.push('\n');
    }
    buffer.push_str(line);
    cache.insert(
        THINKING_KEY.to_string(),
        (String::new(), Value::String(buffer)),
    );
}

/// Drains the accumulated reasoning into a single event, if there is any.
fn take_thinking(cache: &mut ToolUseCache) -> Option<AgentEvent> {
    let text = cache
        .remove(THINKING_KEY)
        .and_then(|(_, v)| v.as_str().map(str::to_string))?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(AgentEvent::Thinking { text })
}

/// Like `take_thinking`, for the end-of-stream flush where the cache is
/// only borrowed immutably.
fn peek_thinking(cache: &ToolUseCache) -> Option<AgentEvent> {
    let text = cache
        .get(THINKING_KEY)
        .and_then(|(_, v)| v.as_str())?
        .trim();
    (!text.is_empty()).then(|| AgentEvent::Thinking {
        text: text.to_string(),
    })
}

/// Repo-map cache directory Aider creates in the working directory. No
/// flag relocates it, so it gets locally excluded instead.
const TAGS_CACHE: &str = ".aider.tags.cache.v4/";

pub fn session_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("aider-sessions")
}

fn history_path(app_data_dir: &Path, session_id: &str) -> PathBuf {
    session_dir(app_data_dir).join(format!("{session_id}.chat.md"))
}

/// Adds Aider's un-relocatable cache directory to the worktree's local
/// exclude file, so it never appears as an untracked change.
///
/// `.git/info/exclude` is deliberate: it is per-clone and not tracked, so
/// this never shows up as a modification to a file the user owns. Failures
/// are non-fatal — a cluttered SCM pane is not a reason to refuse to run.
pub fn ensure_worktree_exclusions(worktree_root: &str) {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "info/exclude"])
        .current_dir(worktree_root)
        .output();
    let Ok(output) = output else { return };
    if !output.status.success() {
        return;
    }
    let relative = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if relative.is_empty() {
        return;
    }
    let path = Path::new(worktree_root).join(relative);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing.lines().any(|line| line.trim() == TAGS_CACHE) {
            return;
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{TAGS_CACHE}");
    }
}

/// Builds one turn.
///
/// Every flag here was confirmed present in `aider --version 0.86.2`'s
/// `--help`; none is inferred from documentation.
pub fn build_turn(ctx: &TurnCtx, text: &str) -> TurnSpawn {
    // Aider has no session ids of its own, so Maestro assigns one on the
    // first turn and reuses it thereafter. `TurnSpawn::assigned_session_id`
    // carries it back to `manager.rs`, which stores it on the run exactly
    // as it stores an id learned from a CLI's own output.
    let (session_id, assigned) = match ctx.resume_session_id {
        Some(existing) => (existing.to_string(), None),
        None => {
            let minted = uuid::Uuid::new_v4().to_string();
            (minted.clone(), Some(minted))
        }
    };

    let history = history_path(ctx.session_dir, &session_id);
    if let Some(parent) = history.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Forking branches the conversation: copy the transcript so far into
    // the new session and let it diverge from there. That the underlying
    // CLI has no notion of this is precisely why it's a file copy.
    if ctx.fork_session {
        if let Some(previous) = ctx.resume_session_id {
            let _ = std::fs::copy(history_path(ctx.session_dir, previous), &history);
        }
    }

    ensure_worktree_exclusions(ctx.worktree_root);

    let mut cmd = Command::new(ctx.binary_path);
    cmd.arg("--message").arg(text);

    if let Some(model) = ctx.model {
        cmd.arg("--model").arg(model);
    }
    if let Some(effort) = ctx.effort {
        // Only ever sent for models whose catalog entry advertised effort
        // support — see `catalog.rs`. Aider explicitly allows this for
        // OpenRouter models (`models.py`'s accepts_settings handling).
        cmd.arg("--reasoning-effort").arg(effort);
    }

    match ctx.permission_mode {
        // A real read-only mode: `ask` is one of Aider's edit formats and
        // discusses without editing. Confirmed by passing an invalid value
        // and reading the accepted list off the error.
        PermissionMode::Plan => {
            cmd.arg("--chat-mode").arg("ask");
        }
        // Aider's confirmations are interactive stdin prompts with no
        // machine-readable form, so Maestro cannot gate them (see
        // `capabilities.rs`). Passing `--yes-always` in both modes is the
        // honest choice: without it the child blocks on a prompt nobody can
        // answer, because stdin is closed. The mode picker says so rather
        // than implying an approval step that doesn't exist.
        PermissionMode::Manual | PermissionMode::Auto => {
            cmd.arg("--yes-always");
        }
    }

    cmd.arg("--chat-history-file").arg(&history);
    // Keep Aider's other two history files out of the user's worktree too.
    cmd.arg("--input-history-file")
        .arg(history.with_extension("input"));
    cmd.arg("--llm-history-file")
        .arg(history.with_extension("llm"));
    if history.exists() {
        cmd.arg("--restore-chat-history");
    }

    cmd.args([
        // Human-facing ANSI repainting would corrupt line-oriented parsing.
        "--no-pretty",
        // Maestro's diff view and commit box own committing; Aider's
        // auto-commit would race them and bury changes in its own commits.
        "--no-auto-commits",
        // Don't edit the user's .gitignore — see this module's header.
        "--no-gitignore",
        // Neither belongs in a turn's output stream.
        "--no-check-update",
        "--no-analytics",
        // Model warnings are advisory noise for models Maestro already
        // listed as available.
        "--no-show-model-warnings",
    ]);
    cmd.arg(if ctx.stream_deltas {
        "--stream"
    } else {
        "--no-stream"
    });

    for (key, value) in ctx.extra_env {
        cmd.env(key, value);
    }

    cmd.current_dir(ctx.worktree_root)
        // Closed immediately by `manager.rs` (no `stdin_payload`), which is
        // what makes `--yes-always` mandatory above.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    TurnSpawn {
        command: cmd,
        stdin_payload: None,
        assigned_session_id: assigned,
    }
}

/// Lines Aider prints as chrome rather than content. Dropping these keeps
/// the transcript to what the model actually said.
fn is_banner(line: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "Aider v",
        "Model:",
        "Git repo:",
        "Repo-map:",
        "Added .aider",
        "You can skip this check with",
        "Warning: Input is not a terminal",
        "Warning: Streaming is not supported",
        "Initial repo scan can be slow",
        "Use /help",
        "Note: in-chat filenames are always relative",
        // Emitted as a pair when a model rejects a setting, e.g.
        // "Warning: <model> does not support 'reasoning_effort', ignoring."
        // followed by the flag that would force it. Advisory, and not the
        // assistant talking.
        "Use --no-check-model-accepts-settings",
    ];
    PREFIXES.iter().any(|prefix| line.starts_with(prefix))
        || (line.starts_with("Warning: ") && line.ends_with(", ignoring."))
        // The horizontal rules Aider draws between sections.
        || (!line.is_empty() && line.chars().all(|c| c == '─' || c == '-' || c == '='))
}

/// A tqdm progress bar frame, as Aider's repo scan emits on stderr.
///
/// These are the reason stderr can't be forwarded verbatim: tqdm redraws
/// in place with carriage returns, so an entire scan arrives as *one*
/// newline-terminated line hundreds of frames long. Rendered as an error
/// event, that became the wall of red text in the transcript.
fn is_progress_frame(line: &str) -> bool {
    (line.contains("it/s]") || line.contains("s/it]")) && line.contains('%')
}

/// Reserved key marking that stderr is partway through a Python
/// traceback.
const TRACEBACK_KEY: &str = "\0aider.traceback";

/// Aider's stderr, filtered down to things that are actually wrong.
///
/// Two shapes have to be handled beyond plain lines. Aider colours its
/// tracebacks, so raw escape sequences would otherwise render as literal
/// `^[[35m` noise; and a Python traceback spans dozens of lines, each of
/// which would become its own error card. Only the exception line at the
/// end says anything a user can act on, so the frames are logged and the
/// exception is surfaced.
pub fn parse_stderr_line(line: &str, cache: &mut ToolUseCache) -> Vec<AgentEvent> {
    // A terminal shows only what survives the last carriage return, so
    // that is the only frame worth considering.
    let last = line.rsplit('\r').next().unwrap_or(line);
    let clean = crate::agents::strip_ansi(last);
    let clean = clean.trim_end();
    let body = clean.trim_start();

    if body.is_empty() || is_banner(body) || is_progress_frame(body) {
        return Vec::new();
    }

    if body.starts_with("Traceback (most recent call last)") {
        cache.insert(
            TRACEBACK_KEY.to_string(),
            (String::new(), Value::Bool(true)),
        );
        return Vec::new();
    }

    if cache.contains_key(TRACEBACK_KEY) {
        // Frames are indented; the unindented line that follows them is
        // the exception itself, and the only part worth showing.
        if clean.starts_with(char::is_whitespace) {
            log::debug!("aider traceback: {clean}");
            return Vec::new();
        }
        cache.remove(TRACEBACK_KEY);
        return vec![AgentEvent::Error {
            message: body.to_string(),
        }];
    }

    vec![AgentEvent::Error {
        message: body.to_string(),
    }]
}

/// Everything Aider prints that isn't the model talking: the startup
/// banner plus the usage and cost reports.
///
/// Shared with `one_shot.rs`, which needs the same "just the answer,
/// please" filter but has no event stream to route the pieces into.
pub fn is_noise(line: &str) -> bool {
    let trimmed = line.trim_start();
    is_banner(trimmed) || parse_tokens_line(trimmed).is_some() || parse_cost_line(trimmed).is_some()
}

/// Aider abbreviates counts above 1000 (`format_tokens` in
/// `coders/base_coder.py`), so "1.2k" and "42k" both appear alongside bare
/// integers.
fn parse_count(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let (number, multiplier) = match raw.strip_suffix(['k', 'K']) {
        Some(rest) => (rest, 1_000.0),
        None => match raw.strip_suffix(['m', 'M']) {
            Some(rest) => (rest, 1_000_000.0),
            None => (raw, 1.0),
        },
    };
    number
        .trim()
        .parse::<f64>()
        .ok()
        .map(|value| (value * multiplier).round() as u64)
}

#[derive(Default, Clone, Copy)]
struct Usage {
    sent: Option<u64>,
    received: Option<u64>,
    cache_write: Option<u64>,
    cache_hit: Option<u64>,
    cost: Option<f64>,
    round_trips: u32,
}

/// Parses `Tokens: 1.2k sent, 500 cache write, 3.4k cache hit, 28 received.`
///
/// Every segment except `sent`/`received` is conditional on the provider
/// reporting it, so this reads segment by segment rather than matching a
/// fixed shape.
fn parse_tokens_line(line: &str) -> Option<Usage> {
    let rest = line.strip_prefix("Tokens:")?;
    let mut usage = Usage {
        round_trips: 1,
        ..Usage::default()
    };
    for segment in rest.trim_end_matches('.').split(',') {
        let segment = segment.trim();
        if let Some(value) = segment.strip_suffix(" sent") {
            usage.sent = parse_count(value);
        } else if let Some(value) = segment.strip_suffix(" received") {
            usage.received = parse_count(value);
        } else if let Some(value) = segment.strip_suffix(" cache write") {
            usage.cache_write = parse_count(value);
        } else if let Some(value) = segment.strip_suffix(" cache hit") {
            usage.cache_hit = parse_count(value);
        }
    }
    Some(usage)
}

/// Parses `Cost: $0.0123 message, $0.0456 session.`
///
/// The session total is the useful one — a turn can span several round
/// trips, and the per-message figure only covers the last of them.
fn parse_cost_line(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("Cost:")?;
    let session = rest.split(',').find(|part| part.contains("session"))?;
    session
        .trim()
        .trim_start_matches('$')
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
}

fn load_usage(cache: &ToolUseCache) -> Usage {
    let Some((_, value)) = cache.get(USAGE_KEY) else {
        return Usage::default();
    };
    Usage {
        sent: value.get("sent").and_then(|v| v.as_u64()),
        received: value.get("received").and_then(|v| v.as_u64()),
        cache_write: value.get("cacheWrite").and_then(|v| v.as_u64()),
        cache_hit: value.get("cacheHit").and_then(|v| v.as_u64()),
        cost: value.get("cost").and_then(|v| v.as_f64()),
        round_trips: value
            .get("roundTrips")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    }
}

fn store_last_error(cache: &mut ToolUseCache, message: &str) {
    cache.insert(
        ERROR_KEY.to_string(),
        (String::new(), Value::String(message.to_string())),
    );
}

fn load_last_error(cache: &ToolUseCache) -> Option<String> {
    cache
        .get(ERROR_KEY)
        .and_then(|(_, value)| value.as_str())
        .map(str::to_string)
}

fn store_usage(cache: &mut ToolUseCache, usage: Usage) {
    cache.insert(
        USAGE_KEY.to_string(),
        (
            String::new(),
            json!({
                "sent": usage.sent,
                "received": usage.received,
                "cacheWrite": usage.cache_write,
                "cacheHit": usage.cache_hit,
                "cost": usage.cost,
                "roundTrips": usage.round_trips,
            }),
        ),
    );
}

/// Token counts accumulate across a turn's round trips; cost is already a
/// running session total, so it is replaced rather than summed.
fn merge(total: Usage, next: Usage) -> Usage {
    fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
        match (a, b) {
            (None, None) => None,
            _ => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        }
    }
    Usage {
        sent: add(total.sent, next.sent),
        received: add(total.received, next.received),
        cache_write: add(total.cache_write, next.cache_write),
        cache_hit: add(total.cache_hit, next.cache_hit),
        cost: next.cost.or(total.cost),
        round_trips: total.round_trips + next.round_trips,
    }
}

/// Aider reports failures as prose and still exits 0 — confirmed with an
/// invalid API key, which printed a LiteLLM authentication error and
/// returned success. Exit status therefore can't be used to decide whether
/// a turn failed; these markers are what's left.
fn is_error_line(line: &str) -> bool {
    line.starts_with("litellm.")
        || line.starts_with("Error")
        || line.contains("The API provider is not able to authenticate you")
        || line.starts_with("Unexpected error")
}

pub fn parse_line(
    line: &str,
    cache: &mut ToolUseCache,
    _stream_deltas: bool,
) -> (Vec<AgentEvent>, Option<String>) {
    let trimmed = line.trim_end();
    let body = trimmed.trim_start();

    // Aider's startup announcement is a *block*, not a set of lines with
    // known prefixes. It wraps at the console width, so a long
    // "Model: … , reasoning high" splits and leaves an orphan
    // "reasoning high" that no prefix rule can catch — which is exactly
    // what leaked into the transcript. Treating everything from the
    // version line to the first blank line as chrome handles the wrap
    // however it falls.
    if matches!(load_mode(cache), Mode::Banner) {
        if body.is_empty() {
            store_mode(cache, Mode::Prose);
        }
        return (Vec::new(), None);
    }
    if body.starts_with("Aider v") {
        store_mode(cache, Mode::Banner);
        return (Vec::new(), None);
    }

    // Aider renders a reasoning model's `<think>` block as its own
    // section, delimited by these two markers (`reasoning_tags.py`'s
    // REASONING_START / REASONING_END). Left as prose they became a wall
    // of the model's private deliberation in the middle of the answer;
    // routed here they become a proper collapsed thinking block.
    if body.starts_with(THINKING_MARKER) {
        store_mode(cache, Mode::Thinking);
        return (Vec::new(), None);
    }
    if body.starts_with(ANSWER_MARKER) {
        store_mode(cache, Mode::Prose);
        // One event per section, not per line: the transcript starts a new
        // collapsed block for every `Thinking` it receives, so streaming
        // these line by line would produce hundreds of them.
        return (take_thinking(cache).into_iter().collect(), None);
    }
    // Checked before the reasoning buffer takes the line: the `----` rule
    // Aider prints just above each marker would otherwise be captured as
    // the first line of the thinking text.
    if is_banner(body) {
        return (Vec::new(), None);
    }

    if matches!(load_mode(cache), Mode::Thinking) {
        push_thinking(cache, trimmed);
        return (Vec::new(), None);
    }

    if let Some(usage) = parse_tokens_line(trimmed.trim_start()) {
        let merged = merge(load_usage(cache), usage);
        store_usage(cache, merged);
        return (Vec::new(), None);
    }

    if let Some(cost) = parse_cost_line(trimmed.trim_start()) {
        let mut current = load_usage(cache);
        current.cost = Some(cost);
        store_usage(cache, current);
        return (Vec::new(), None);
    }

    // "Applied edit to src/main.rs" is Aider's only structured statement
    // about what it changed. Promoting it to a tool call/result pair is
    // what puts a file-change card in the transcript instead of burying
    // the one line that matters in a wall of prose.
    if let Some(path) = trimmed.trim_start().strip_prefix("Applied edit to ") {
        let path = path.trim();
        let id = format!("aider-edit-{path}");
        return (
            vec![
                AgentEvent::ToolCall {
                    id: id.clone(),
                    name: "EditFile".to_string(),
                    input: json!({ "path": path }),
                },
                AgentEvent::ToolResult {
                    tool_use_id: id,
                    content: format!("Applied edit to {path}"),
                    is_error: false,
                    // Aider prints no per-edit line counts; Maestro's own
                    // diff view is the source of truth for those.
                    diff_added: None,
                    diff_removed: None,
                },
            ],
            None,
        );
    }

    if is_error_line(trimmed.trim_start()) {
        let message = trimmed.trim_start().to_string();
        store_last_error(cache, &message);
        return (vec![AgentEvent::Error { message }], None);
    }

    // Everything else is the model talking. Blank lines are preserved
    // because Aider's replies are markdown, where they are paragraph and
    // code-fence separators rather than noise.
    (
        vec![AgentEvent::MessageDelta {
            text: format!("{trimmed}\n"),
        }],
        None,
    )
}

/// Emitted once the child's stdout has closed, to turn the usage totals
/// accumulated across the turn's round trips into a single `TurnResult`.
///
/// Aider prints no end-of-turn record — unlike the other three CLIs, whose
/// final JSON line carries the result — so this is where a turn's summary
/// comes from.
/// A turn always ends with a result, even a failed one.
///
/// This is load-bearing rather than tidy: the transcript leaves its
/// "working" state on `turnResult`, and treats a bare `exit` as a crash.
/// Aider exits 0 even when it never reached the model, so a turn that
/// failed on a bad key used to end as "Agent process exited unexpectedly"
/// — blaming the process for something the provider rejected. Reporting
/// the real reason requires saying the turn happened at all.
pub fn finish(
    cache: &ToolUseCache,
    session_id: &str,
    duration_ms: u64,
    interrupted: bool,
) -> Vec<AgentEvent> {
    // A turn that ends while still inside a reasoning section would
    // otherwise lose it — Aider only closes one with an ANSWER marker when
    // an answer actually follows.
    let mut events: Vec<AgentEvent> = peek_thinking(cache).into_iter().collect();
    let usage = load_usage(cache);
    // Stopping a turn is a normal thing to do, not a failure. Treating it
    // as one meant the Stop button produced a red banner telling the user
    // to go check their API key.
    let reached_the_model = usage.round_trips > 0 || interrupted;
    let failure = load_last_error(cache);

    events.push(AgentEvent::TurnResult {
        session_id: session_id.to_string(),
        // Nothing came back from the model, so whatever else happened,
        // this turn did not do what was asked.
        is_error: !reached_the_model,
        total_cost_usd: usage.cost,
        duration_ms,
        num_turns: usage.round_trips,
        input_tokens: usage.sent,
        output_tokens: usage.received,
        cache_read_tokens: usage.cache_hit,
        cache_write_tokens: usage.cache_write,
        // Aider never reports the model's context window.
        context_window: None,
        result_text: if reached_the_model {
            None
        } else {
            // Aider's own words where it gave any — a LiteLLM
            // authentication error says far more than Maestro could.
            Some(failure.unwrap_or_else(|| {
                "Aider ended without a reply from the model. Check the provider's key and model in Settings → Agents."
                    .to_string()
            }))
        },
    });
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str, cache: &mut ToolUseCache) -> Vec<AgentEvent> {
        parse_line(line, cache, true).0
    }

    #[test]
    fn banner_lines_are_dropped() {
        // Captured verbatim from a real aider 0.86.2 run.
        let mut cache = ToolUseCache::new();
        for line in [
            "Aider v0.86.2",
            "Model: openai/mock-model with whole edit format",
            "Git repo: .git with 1 files",
            "Repo-map: using 1024 tokens, auto refresh",
            "Warning: Input is not a terminal (fd=0).",
            "Added .aider* to .gitignore",
        ] {
            assert!(
                parse(line, &mut cache).is_empty(),
                "should have dropped: {line}"
            );
        }
    }

    #[test]
    fn prose_becomes_a_delta_preserving_blank_lines() {
        let mut cache = ToolUseCache::new();
        let events = parse("Here is the change you asked for.", &mut cache);
        match &events[0] {
            AgentEvent::MessageDelta { text } => {
                assert_eq!(text, "Here is the change you asked for.\n")
            }
            other => panic!("expected a delta, got {other:?}"),
        }
        // Markdown needs its blank lines to keep paragraphs and fences apart.
        match &parse("", &mut cache)[0] {
            AgentEvent::MessageDelta { text } => assert_eq!(text, "\n"),
            other => panic!("expected a delta, got {other:?}"),
        }
    }

    #[test]
    fn token_counts_parse_including_abbreviations() {
        assert_eq!(parse_count("776"), Some(776));
        assert_eq!(parse_count("1.2k"), Some(1_200));
        assert_eq!(parse_count("42k"), Some(42_000));
        assert_eq!(parse_count("1.5M"), Some(1_500_000));
        assert_eq!(parse_count("nonsense"), None);
    }

    #[test]
    fn a_real_tokens_line_parses() {
        // Exactly as captured from a live run.
        let usage = parse_tokens_line("Tokens: 776 sent, 28 received.").unwrap();
        assert_eq!(usage.sent, Some(776));
        assert_eq!(usage.received, Some(28));
        assert_eq!(usage.cache_write, None);
    }

    #[test]
    fn a_tokens_line_with_cache_segments_parses() {
        let usage =
            parse_tokens_line("Tokens: 1.2k sent, 500 cache write, 3.4k cache hit, 28 received.")
                .unwrap();
        assert_eq!(usage.sent, Some(1_200));
        assert_eq!(usage.cache_write, Some(500));
        assert_eq!(usage.cache_hit, Some(3_400));
        assert_eq!(usage.received, Some(28));
    }

    #[test]
    fn cost_line_takes_the_session_total() {
        assert_eq!(
            parse_cost_line("Cost: $0.0123 message, $0.0456 session."),
            Some(0.0456)
        );
    }

    #[test]
    fn usage_accumulates_across_round_trips_and_finishes_once() {
        // A single user-visible turn really does print this twice — it was
        // observed doing so when Aider re-sent after reading a file.
        let mut cache = ToolUseCache::new();
        assert!(parse("Tokens: 776 sent, 28 received.", &mut cache).is_empty());
        assert!(parse("Tokens: 793 sent, 30 received.", &mut cache).is_empty());
        assert!(parse("Cost: $0.01 message, $0.05 session.", &mut cache).is_empty());

        let events = finish(&cache, "sess-1", 1234, false);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::TurnResult {
                session_id,
                input_tokens,
                output_tokens,
                total_cost_usd,
                num_turns,
                context_window,
                ..
            } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(*input_tokens, Some(1_569));
                assert_eq!(*output_tokens, Some(58));
                // Cost is a running session total, so the latest wins
                // rather than summing to $0.10.
                assert_eq!(*total_cost_usd, Some(0.05));
                assert_eq!(*num_turns, 2);
                assert_eq!(*context_window, None);
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn a_turn_with_no_usage_reports_no_token_counts() {
        // A turn that failed before reaching the model must not invent
        // zeroed usage — but it still has to close out, which
        // `an_empty_turn_still_closes_out` covers.
        match &finish(&ToolUseCache::new(), "sess", 10, false)[0] {
            AgentEvent::TurnResult {
                input_tokens,
                output_tokens,
                total_cost_usd,
                num_turns,
                ..
            } => {
                assert_eq!(*input_tokens, None);
                assert_eq!(*output_tokens, None);
                assert_eq!(*total_cost_usd, None);
                assert_eq!(*num_turns, 0);
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn applied_edits_become_a_tool_call_pair() {
        let mut cache = ToolUseCache::new();
        let events = parse("Applied edit to hello.py", &mut cache);
        assert_eq!(events.len(), 2);
        match (&events[0], &events[1]) {
            (
                AgentEvent::ToolCall { id, name, input },
                AgentEvent::ToolResult {
                    tool_use_id,
                    is_error,
                    ..
                },
            ) => {
                assert_eq!(name, "EditFile");
                assert_eq!(input["path"], "hello.py");
                assert_eq!(id, tool_use_id);
                assert!(!is_error);
            }
            other => panic!("expected a call/result pair, got {other:?}"),
        }
    }

    /// Replays a whole captured stdout through the parser the way
    /// `manager.rs` does, and returns the reconstructed assistant text
    /// alongside the other events.
    fn replay(fixture: &str) -> (String, Vec<AgentEvent>, Vec<AgentEvent>) {
        let raw = std::fs::read_to_string(format!(
            "{}/tests/fixtures/aider/{fixture}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("fixture missing");

        let mut cache = ToolUseCache::new();
        let mut text = String::new();
        let mut others = Vec::new();
        for line in raw.lines() {
            let (events, _) = parse_line(line, &mut cache, true);
            for event in events {
                match event {
                    AgentEvent::MessageDelta { text: fragment } => text.push_str(&fragment),
                    other => others.push(other),
                }
            }
        }
        let finished = finish(&cache, "sess-1", 4_200, false);
        (text, others, finished)
    }

    #[test]
    fn a_real_captured_turn_reconstructs_cleanly() {
        // Captured from aider 0.86.2 driven against a local
        // OpenAI-compatible server, using exactly the flags `build_turn`
        // emits. This is the whole adapter working end to end on real
        // output rather than on output we imagined.
        let (text, others, finished) = replay("01_edit_turn.txt");

        // None of Aider's startup chrome reaches the transcript...
        assert!(
            !text.contains("Aider v0.86.2"),
            "banner leaked into the transcript:\n{text}"
        );
        assert!(!text.contains("Git repo:"));
        assert!(!text.contains("Repo-map:"));
        assert!(!text.contains("Input is not a terminal"));
        // ...nor do the usage reports, which become the turn result.
        assert!(!text.contains("Tokens:"));
        // ...but the model's actual reply, including its code fence, does.
        assert!(text.contains("Here is the change you asked for."));
        assert!(text.contains("def greet():"));
        assert!(text.contains("```python"));

        // The one line that says what changed is promoted to a card.
        let edits: Vec<_> = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall { name, input, .. } if name == "EditFile" => {
                    Some(input["path"].as_str().unwrap_or_default().to_string())
                }
                _ => None,
            })
            .collect();
        assert_eq!(edits, vec!["hello.py"]);

        // No spurious errors from ordinary prose.
        assert!(
            !others.iter().any(|e| matches!(e, AgentEvent::Error { .. })),
            "unexpected errors: {others:?}"
        );

        // Both round trips' tokens are summed into a single result. This
        // fixture has no `Cost:` line because the mock model has no pricing
        // in LiteLLM's table — reported as unknown, not as free.
        match &finished[0] {
            AgentEvent::TurnResult {
                input_tokens,
                output_tokens,
                num_turns,
                total_cost_usd,
                ..
            } => {
                assert_eq!(*input_tokens, Some(776 + 793));
                assert_eq!(*output_tokens, Some(56));
                assert_eq!(*num_turns, 2);
                assert_eq!(*total_cost_usd, None);
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    fn args_for(mode: PermissionMode, dir: &std::path::Path) -> Vec<String> {
        let ctx = TurnCtx {
            binary_path: "aider",
            worktree_root: "/tmp",
            resume_session_id: None,
            fork_session: false,
            allowed_tools: &[],
            model: Some("openrouter/anthropic/claude-x"),
            effort: Some("high"),
            fast: false,
            permission_mode: mode,
            stream_deltas: true,
            extra_env: &[],
            session_dir: dir,
        };
        build_turn(&ctx, "hi")
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_turn_carries_the_flags_that_keep_the_worktree_clean() {
        let dir = tempfile::tempdir().unwrap();
        let args = args_for(PermissionMode::Auto, dir.path());
        // Each of these prevents a specific observed side effect: ANSI
        // repainting that breaks parsing, Aider committing on its own, and
        // Aider editing the user's .gitignore on first run.
        for flag in [
            "--no-pretty",
            "--no-auto-commits",
            "--no-gitignore",
            "--message",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag} in {args:?}");
        }
        // The history file is what gives a session-less CLI continuity.
        assert!(args.iter().any(|a| a == "--chat-history-file"));
    }

    #[test]
    fn plan_mode_uses_the_read_only_chat_mode() {
        let dir = tempfile::tempdir().unwrap();
        let args = args_for(PermissionMode::Plan, dir.path());
        let index = args
            .iter()
            .position(|a| a == "--chat-mode")
            .expect("no --chat-mode");
        assert_eq!(args[index + 1], "ask");
        // Plan mode must not also assert blanket consent to act.
        assert!(!args.iter().any(|a| a == "--yes-always"));
    }

    #[test]
    fn effort_is_sent_as_its_own_flag() {
        let dir = tempfile::tempdir().unwrap();
        let args = args_for(PermissionMode::Auto, dir.path());
        let index = args
            .iter()
            .position(|a| a == "--reasoning-effort")
            .expect("no effort flag");
        assert_eq!(args[index + 1], "high");
    }

    #[test]
    fn a_fresh_turn_mints_a_session_id_and_resuming_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let base = TurnCtx {
            binary_path: "aider",
            worktree_root: "/tmp",
            resume_session_id: None,
            fork_session: false,
            allowed_tools: &[],
            model: None,
            effort: None,
            fast: false,
            permission_mode: PermissionMode::Auto,
            stream_deltas: false,
            extra_env: &[],
            session_dir: dir.path(),
        };
        let minted = build_turn(&base, "hi")
            .assigned_session_id
            .expect("should mint an id");

        // Resuming reuses the caller's id rather than minting a second one,
        // which is what keeps a run pointed at one history file.
        let resumed = TurnCtx {
            resume_session_id: Some(&minted),
            ..base
        };
        assert!(build_turn(&resumed, "hi").assigned_session_id.is_none());
    }

    #[test]
    fn provider_credentials_travel_as_environment_not_argv() {
        // argv is world-readable through /proc on Linux, so a key on the
        // command line would leak to every process on the machine.
        let dir = tempfile::tempdir().unwrap();
        let env = [("OPENROUTER_API_KEY".to_string(), "sk-secret".to_string())];
        let ctx = TurnCtx {
            binary_path: "aider",
            worktree_root: "/tmp",
            resume_session_id: None,
            fork_session: false,
            allowed_tools: &[],
            model: Some("openrouter/anthropic/claude-x"),
            effort: None,
            fast: false,
            permission_mode: PermissionMode::Auto,
            stream_deltas: false,
            extra_env: &env,
            session_dir: dir.path(),
        };
        let spawn = build_turn(&ctx, "hi");
        let command = spawn.command.as_std();
        assert!(
            !command
                .get_args()
                .any(|a| a.to_string_lossy().contains("sk-secret")),
            "the key must never appear in argv"
        );
        assert!(command.get_envs().any(|(k, v)| k == "OPENROUTER_API_KEY"
            && v.is_some_and(|v| v.to_string_lossy() == "sk-secret")));
    }

    #[test]
    fn a_reasoning_model_turn_separates_thinking_from_the_answer() {
        // The whole pipeline on a reasoning-model turn: wrapped
        // announcement, a THINKING section, the answer, and usage. This is
        // the shape that rendered as one undifferentiated wall of prose.
        let (text, others, finished) = replay("02_reasoning_turn.txt");

        // The announcement is gone, including the orphaned "reasoning
        // high" left behind by its wrap.
        assert!(
            !text.contains("reasoning high"),
            "wrapped banner leaked:\n{text}"
        );
        assert!(!text.contains("Aider v0.86.2"));
        assert!(!text.contains("aider.chat/docs/faq"));

        // The model's private deliberation is a thinking block, not prose.
        let thinking: Vec<&String> = others
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Thinking { text } => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(thinking.len(), 1, "expected exactly one thinking block");
        assert!(thinking[0].contains("We need to respond with a list of files"));
        assert!(
            !text.contains("We need to respond"),
            "reasoning leaked into the answer"
        );

        // ...and the answer is the only thing left in the message body,
        // with its markdown intact.
        assert!(text.contains("This repository is a monorepo"));
        assert!(text.contains("- **apps/admin**"));
        assert!(!text.contains("THINKING"));
        assert!(!text.contains("ANSWER"));

        match &finished[0] {
            AgentEvent::TurnResult {
                is_error,
                input_tokens,
                total_cost_usd,
                ..
            } => {
                assert!(!is_error);
                assert_eq!(*input_tokens, Some(3_400));
                assert_eq!(*total_cost_usd, Some(0.0021));
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_sections_become_thinking_blocks() {
        // Markers copied from aider's `reasoning_tags.py`
        // (REASONING_START / REASONING_END).
        let mut cache = ToolUseCache::new();
        assert!(parse("--------------", &mut cache).is_empty());
        assert!(parse("► **THINKING**", &mut cache).is_empty());
        assert!(parse("We need to respond with a list of files.", &mut cache).is_empty());
        assert!(parse("But they asked \"what is this codebase?\"", &mut cache).is_empty());
        assert!(parse("------------", &mut cache).is_empty());

        // The whole section arrives as ONE thinking block. Per-line events
        // would start a new collapsed block for every line.
        let events = parse("► **ANSWER**", &mut cache);
        match events.as_slice() {
            [AgentEvent::Thinking { text }] => {
                assert!(text.contains("We need to respond"));
                assert!(text.contains("what is this codebase?"));
                assert_eq!(text.lines().count(), 2);
            }
            other => panic!("expected one thinking block, got {other:?}"),
        }

        // ...and what follows is the answer, as ordinary prose.
        match &parse("This repository is a monorepo.", &mut cache)[0] {
            AgentEvent::MessageDelta { text } => {
                assert_eq!(text, "This repository is a monorepo.\n")
            }
            other => panic!("expected prose, got {other:?}"),
        }
    }

    #[test]
    fn a_second_reasoning_section_is_kept_separate() {
        // Aider alternates THINKING/ANSWER across round trips within one
        // turn, so the state machine has to reset cleanly.
        let mut cache = ToolUseCache::new();
        parse("► **THINKING**", &mut cache);
        parse("first thought", &mut cache);
        parse("► **ANSWER**", &mut cache);
        parse("► **THINKING**", &mut cache);
        parse("second thought", &mut cache);
        match &parse("► **ANSWER**", &mut cache)[0] {
            AgentEvent::Thinking { text } => {
                assert_eq!(
                    text, "second thought",
                    "the first section leaked into the second"
                );
            }
            other => panic!("expected thinking, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_left_open_at_the_end_is_still_reported() {
        let mut cache = ToolUseCache::new();
        parse("► **THINKING**", &mut cache);
        parse("cut off mid-thought", &mut cache);
        let events = finish(&cache, "sess", 10, false);
        assert!(
            matches!(&events[0], AgentEvent::Thinking { text } if text == "cut off mid-thought"),
            "unterminated reasoning was dropped: {events:?}"
        );
    }

    #[test]
    fn the_wrapped_startup_banner_is_dropped_whole() {
        // Aider's announcement wraps at the console width, so a long
        // "Model: … , reasoning high" splits and leaves an orphan
        // "reasoning high" that no prefix rule catches — it showed up as
        // the first line of the reply. The block runs to the first blank
        // line, however the wrapping falls.
        let mut cache = ToolUseCache::new();
        for line in [
            "Aider v0.86.2",
            "Model: openrouter/x with diff edit format, prompt cache,",
            "reasoning high",
            "Git repo: .git with 4,550 files",
            "Warning: For large repos, consider using --subtree-only and .aiderignore",
            "See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo",
        ] {
            assert!(parse(line, &mut cache).is_empty(), "leaked: {line}");
        }
        // The blank line ends the announcement; real output follows.
        assert!(parse("", &mut cache).is_empty());
        match &parse("Here is the answer.", &mut cache)[0] {
            AgentEvent::MessageDelta { text } => assert_eq!(text, "Here is the answer.\n"),
            other => panic!("expected prose after the banner, got {other:?}"),
        }
    }

    #[test]
    fn the_repo_scan_progress_bar_is_not_an_error() {
        // Captured from a real run: tqdm redraws in place with carriage
        // returns, so an entire scan arrives as ONE newline-terminated
        // stderr line. Forwarded verbatim it filled the transcript with a
        // wall of red text that wasn't an error at all.
        let line = "\rScanning repo:   0%|          | 0/234 [00:00<?, ?it/s]\
                    \rScanning repo:  17%|██        | 39/234 [00:00<00:01, 116.29it/s]\
                    \rScanning repo: 100%|██████████| 234/234 [00:01<00:00, 152.05it/s]";
        assert!(
            parse_stderr_line(line, &mut ToolUseCache::new()).is_empty(),
            "progress bar leaked into the transcript"
        );
    }

    #[test]
    fn the_not_a_terminal_notice_is_not_an_error() {
        // Printed on stderr for every non-interactive run, so it appeared
        // on every single turn.
        assert!(parse_stderr_line(
            "Warning: Input is not a terminal (fd=0).",
            &mut ToolUseCache::new()
        )
        .is_empty());
    }

    #[test]
    fn a_genuine_stderr_line_still_surfaces() {
        // The filter must not swallow real failures.
        let events = parse_stderr_line("Killed: out of memory", &mut ToolUseCache::new());
        assert!(matches!(events.as_slice(), [AgentEvent::Error { .. }]));
    }

    #[test]
    fn a_python_traceback_collapses_to_its_exception() {
        // Pressing Stop sends SIGINT, which Python raises as a
        // KeyboardInterrupt — dozens of stderr lines, each of which used
        // to become its own red card, complete with raw ANSI escapes. Only
        // the exception line says anything a user can act on.
        let mut cache = ToolUseCache::new();
        let frames = [
            "Traceback (most recent call last):",
            "  File \u{1b}[35m\"/home/x/litellm/llms/custom_httpx/llm_http_handler.py\"\u{1b}[0m, line \u{1b}[35m221\u{1b}[0m, in \u{1b}[35m_make_common_sync_call\u{1b}[0m",
            "    response = sync_httpx_client.post(",
            "    ...<8 lines>...",
            "  File \u{1b}[35m\"/home/x/http_handler.py\"\u{1b}[0m, line \u{1b}[35m1028\u{1b}[0m, in \u{1b}[35mpost\u{1b}[0m",
            "    raise e",
        ];
        for frame in frames {
            assert!(
                parse_stderr_line(frame, &mut cache).is_empty(),
                "traceback frame leaked: {frame}"
            );
        }

        // The unindented line that ends a traceback is the exception, and
        // it is the one thing worth showing — with no escape sequences.
        match parse_stderr_line("KeyboardInterrupt", &mut cache).as_slice() {
            [AgentEvent::Error { message }] => assert_eq!(message, "KeyboardInterrupt"),
            other => panic!("expected one error, got {other:?}"),
        }

        // ...and the parser is back to normal afterwards.
        assert!(!parse_stderr_line("something else broke", &mut cache).is_empty());
    }

    #[test]
    fn ansi_escapes_never_reach_the_transcript() {
        match parse_stderr_line("\u{1b}[31mreal failure\u{1b}[0m", &mut ToolUseCache::new())
            .as_slice()
        {
            [AgentEvent::Error { message }] => assert_eq!(message, "real failure"),
            other => panic!("expected a clean error, got {other:?}"),
        }
    }

    #[test]
    fn stopping_a_turn_is_not_a_failure() {
        // The Stop button used to end with a red "Aider ended without a
        // reply from the model. Check the provider's key…" banner, which
        // blamed the provider for something the user did on purpose.
        match &finish(&ToolUseCache::new(), "sess", 10, true)[0] {
            AgentEvent::TurnResult {
                is_error,
                result_text,
                ..
            } => {
                assert!(!is_error, "a deliberate stop must not read as an error");
                assert!(result_text.is_none());
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn a_rejected_setting_notice_is_chrome_not_prose() {
        // Aider emits this pair when a model won't accept a flag. Useful,
        // but not the assistant speaking.
        let mut cache = ToolUseCache::new();
        assert!(parse(
            "Warning: openai/mock-model does not support 'reasoning_effort', ignoring.",
            &mut cache
        )
        .is_empty());
        assert!(parse(
            "Use --no-check-model-accepts-settings to force the 'reasoning_effort' setting.",
            &mut cache
        )
        .is_empty());
    }

    #[test]
    fn a_turn_that_never_reached_the_model_reports_why() {
        // Aider exits 0 even on an auth failure, so without a result event
        // the transcript blamed the process for exiting "unexpectedly"
        // instead of showing the provider's actual complaint.
        let mut cache = ToolUseCache::new();
        parse(
            "litellm.AuthenticationError: AnthropicException - API key is invalid.",
            &mut cache,
        );
        let events = finish(&cache, "sess-1", 900, false);
        match &events[0] {
            AgentEvent::TurnResult {
                is_error,
                result_text,
                ..
            } => {
                assert!(is_error);
                assert!(
                    result_text
                        .as_deref()
                        .unwrap_or_default()
                        .contains("AuthenticationError"),
                    "should quote Aider's own error, got {result_text:?}"
                );
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_turn_still_closes_out() {
        // Even with nothing to report, the turn has to end — the
        // transcript only leaves its "working" state on a result.
        let events = finish(&ToolUseCache::new(), "sess", 10, false);
        match &events[0] {
            AgentEvent::TurnResult {
                is_error,
                result_text,
                ..
            } => {
                assert!(is_error);
                assert!(
                    result_text.is_some(),
                    "a failure with no detail still owes an explanation"
                );
            }
            other => panic!("expected a turn result, got {other:?}"),
        }
    }

    #[test]
    fn auth_failures_surface_as_errors() {
        // Aider exits 0 on this, so the text is the only signal.
        let mut cache = ToolUseCache::new();
        let events = parse(
            "litellm.AuthenticationError: AnthropicException - API key is invalid.",
            &mut cache,
        );
        assert!(matches!(events[0], AgentEvent::Error { .. }));
    }
}
