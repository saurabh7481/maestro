//! Session discovery for the agent CLIs Maestro supports — reads their transcript files
//! directly rather than relying on a non-interactive "list sessions" CLI
//! flag, since neither CLI has one (Claude: see `claude.rs`'s module
//! doc; Cursor: `cursor-agent ls` is an interactive TUI that errors out
//! without a TTY — confirmed live). This is the same "CLI's own on-disk
//! state is the source of truth" approach docs/ARCHITECTURE.md §4
//! prescribes. Discovery is global per agent: the UI should match each
//! CLI's own resume picker, not only sessions from worktrees Maestro has open.

use crate::agents::registry::AgentKind;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableSession {
    pub session_id: String,
    pub title: String,
    pub last_active_at: String,
    pub turn_count: u32,
    /// Which worktree this session's on-disk history belongs to (a CLI's
    /// session directory is keyed by sanitized cwd — see `sanitize_cwd`
    /// below) — populated by the caller, not discovered here, since a
    /// single-worktree lookup already knows it without re-deriving it.
    /// Lets `list_resumable_sessions_for_roots` merge sessions from
    /// multiple worktrees into one list while still knowing which
    /// worktree each one has to be resumed against.
    pub worktree_root: String,
}

/// Both Claude Code and Cursor Agent sanitize a worktree's absolute path
/// into a directory name the same way (`/` → `-`) — confirmed for both
/// independently via live inspection, not assumed shared because they're
/// both from the same vendor (they aren't).
fn sanitize_cwd(cwd: &str) -> String {
    cwd.replace('/', "-")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

/// Claude persists UI-only slash commands (`/doctor`, `/usage`, `/model`,
/// `/clear`, etc.) as ordinary top-level JSONL sessions. They are valid
/// resumable CLI records, but not conversations the user started with an
/// agent. Ignore their generated wrapper messages; a session is listed only
/// when at least one real user prompt remains.
fn is_claude_conversation_prompt(text: &str) -> bool {
    let text = text.trim_start();
    !text.starts_with("<local-command-")
        && !text.starts_with("<command-name>")
        && !text.starts_with("<command-message>")
}

async fn mtime_fallback(path: &Path) -> String {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default()
}

async fn child_dirs(path: &Path) -> Vec<PathBuf> {
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
            dirs.push(entry.path());
        }
    }
    dirs
}

async fn jsonl_files(path: &Path) -> Vec<PathBuf> {
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return Vec::new();
    };
    let mut files = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    files
}

// ---------------------------------------------------------------------
// Claude Code: ~/.claude/projects/<sanitized cwd>/<session-uuid>.jsonl
// ---------------------------------------------------------------------

async fn summarize_claude_session_file(
    path: &Path,
    session_id: String,
    worktree_root: &str,
) -> Option<ResumableSession> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut lines = BufReader::new(file).lines();

    let mut ai_title: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    let mut last_timestamp: Option<String> = None;
    let mut turn_count: u32 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("ai-title") => {
                ai_title = value
                    .get("aiTitle")
                    .and_then(|s| s.as_str())
                    .map(str::to_string);
            }
            // Only plain-string `content` is a real, user-typed turn — an
            // array means this `user`-role line is actually a synthetic
            // tool_result echo, not something to count or title from.
            Some("user") => {
                if let Some(text) = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !is_claude_conversation_prompt(text) {
                        continue;
                    }
                    turn_count += 1;
                    if first_user_text.is_none() {
                        first_user_text = Some(text.to_string());
                    }
                }
            }
            _ => {}
        }
        if let Some(ts) = value.get("timestamp").and_then(|t| t.as_str()) {
            last_timestamp = Some(ts.to_string());
        }
    }

    if turn_count == 0 {
        return None;
    }

    let title = ai_title
        .or_else(|| first_user_text.map(|t| truncate(t.trim(), 60)))
        .unwrap_or_else(|| "Untitled session".to_string());
    let last_active_at = match last_timestamp {
        Some(ts) => ts,
        None => mtime_fallback(path).await,
    };

    Some(ResumableSession {
        session_id,
        title,
        last_active_at,
        turn_count,
        worktree_root: worktree_root.to_string(),
    })
}

async fn list_claude_sessions(worktree_root: &str) -> Vec<ResumableSession> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let dir: PathBuf = PathBuf::from(home)
        .join(".claude/projects")
        .join(sanitize_cwd(worktree_root));

    let Ok(mut read_dir) = tokio::fs::read_dir(&dir).await else {
        return Vec::new(); // no sessions recorded for this worktree yet — not an error
    };

    let mut sessions = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if let Some(session) = summarize_claude_session_file(&path, session_id, worktree_root).await
        {
            sessions.push(session);
        }
    }
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    sessions
}

async fn claude_cwd(path: &Path) -> Option<String> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            return Some(cwd.to_string());
        }
    }
    None
}

async fn list_all_claude_sessions(home: &Path) -> Vec<ResumableSession> {
    let base = home.join(".claude/projects");
    let mut sessions = Vec::new();
    for project_dir in child_dirs(&base).await {
        for path in jsonl_files(&project_dir).await {
            let Some(session_id) = path
                .file_stem()
                .and_then(|v| v.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let cwd = claude_cwd(&path).await.unwrap_or_else(|| {
                project_dir
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or_default()
                    .to_string()
            });
            if let Some(session) = summarize_claude_session_file(&path, session_id, &cwd).await {
                sessions.push(session);
            }
        }
    }
    sessions
}

// ---------------------------------------------------------------------
// Cursor Agent: ~/.cursor/projects/<sanitized cwd>/agent-transcripts/
//               <session-uuid>/<session-uuid>.jsonl
// Confirmed live: `{"role":"user","message":{"content":[{"type":"text",
// "text":"<timestamp>...</timestamp>\n<user_query>\n...\n</user_query>"}]}}`
// per real turn — no per-line timestamp field, so `last_active_at` always
// falls back to file mtime (unlike Claude, which usually has one).
// ---------------------------------------------------------------------

fn extract_cursor_user_query(value: &Value) -> Option<String> {
    let text = value
        .get("message")?
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    match (text.find("<user_query>"), text.find("</user_query>")) {
        (Some(s), Some(e)) if e > s => {
            let start = s + "<user_query>".len();
            Some(text[start..e].trim().to_string())
        }
        _ if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

async fn summarize_cursor_session_file(
    path: &Path,
    session_id: String,
    worktree_root: &str,
) -> Option<ResumableSession> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut lines = BufReader::new(file).lines();

    let mut first_user_text: Option<String> = None;
    let mut turn_count: u32 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        if let Some(text) = extract_cursor_user_query(&value) {
            turn_count += 1;
            if first_user_text.is_none() {
                first_user_text = Some(text);
            }
        }
    }

    if turn_count == 0 {
        return None;
    }

    let title = first_user_text
        .map(|t| truncate(t.trim(), 60))
        .unwrap_or_else(|| "Untitled session".to_string());
    let last_active_at = mtime_fallback(path).await;

    Some(ResumableSession {
        session_id,
        title,
        last_active_at,
        turn_count,
        worktree_root: worktree_root.to_string(),
    })
}

async fn list_cursor_sessions(worktree_root: &str) -> Vec<ResumableSession> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let base: PathBuf = PathBuf::from(home)
        .join(".cursor/projects")
        .join(sanitize_cwd(worktree_root))
        .join("agent-transcripts");

    let Ok(mut read_dir) = tokio::fs::read_dir(&base).await else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let session_dir = entry.path();
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(session_id) = session_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };

        // The transcript file is named after the session id in every
        // case observed live, but scan the directory instead of assuming
        // that — cheap, and doesn't break if that ever changes.
        let Ok(mut inner) = tokio::fs::read_dir(&session_dir).await else {
            continue;
        };
        let mut jsonl_path = None;
        while let Ok(Some(inner_entry)) = inner.next_entry().await {
            let path = inner_entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                jsonl_path = Some(path);
                break;
            }
        }
        let Some(jsonl_path) = jsonl_path else {
            continue;
        };

        if let Some(session) =
            summarize_cursor_session_file(&jsonl_path, session_id, worktree_root).await
        {
            sessions.push(session);
        }
    }
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    sessions
}

async fn cursor_root_from_dir(path: &Path) -> String {
    let encoded = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    // Cursor flattens `/` to `-`, which is ambiguous when a real path
    // component itself contains a hyphen. Resolve against the live
    // filesystem instead of displaying a plausible-but-wrong path.
    let mut candidates = vec![(PathBuf::from("/"), encoded.to_string())];
    while let Some((parent, remaining)) = candidates.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&parent).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if !entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if remaining == name {
                return entry.path().to_string_lossy().to_string();
            }
            let Some(next) = remaining.strip_prefix(&format!("{name}-")) else {
                continue;
            };
            candidates.push((entry.path(), next.to_string()));
        }
    }
    encoded.to_string()
}

async fn list_all_cursor_sessions(home: &Path) -> Vec<ResumableSession> {
    let base = home.join(".cursor/projects");
    let mut sessions = Vec::new();
    for project_dir in child_dirs(&base).await {
        let root = cursor_root_from_dir(&project_dir).await;
        let transcripts = project_dir.join("agent-transcripts");
        for session_dir in child_dirs(&transcripts).await {
            let Some(session_id) = session_dir
                .file_name()
                .and_then(|v| v.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            if let Some(path) = jsonl_files(&session_dir).await.into_iter().next() {
                if let Some(session) = summarize_cursor_session_file(&path, session_id, &root).await
                {
                    sessions.push(session);
                }
            }
        }
    }
    sessions
}

// ---------------------------------------------------------------------
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
// ---------------------------------------------------------------------

async fn summarize_codex_session_file(path: &Path) -> Option<ResumableSession> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut lines = BufReader::new(file).lines();
    let mut session_id = None;
    let mut cwd = None;
    let mut first_user_text = None;
    let mut last_timestamp = None;
    let mut turn_count = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
            last_timestamp = Some(timestamp.to_string());
        }
        let event_type = value.get("type").and_then(Value::as_str);
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if event_type == Some("session_meta") {
            session_id = payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string);
        } else if event_type == Some("event_msg")
            && payload.get("type").and_then(Value::as_str) == Some("user_message")
        {
            if let Some(message) = payload.get("message").and_then(Value::as_str) {
                turn_count += 1;
                if first_user_text.is_none() {
                    first_user_text = Some(message.to_string());
                }
            }
        }
    }
    let session_id = session_id?;
    if turn_count == 0 {
        return None;
    }
    Some(ResumableSession {
        session_id,
        title: first_user_text
            .map(|text| truncate(text.trim(), 60))
            .unwrap_or_else(|| "Untitled session".to_string()),
        last_active_at: match last_timestamp {
            Some(timestamp) => timestamp,
            None => mtime_fallback(path).await,
        },
        turn_count,
        worktree_root: cwd.unwrap_or_default(),
    })
}

async fn codex_session_files(home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for year in child_dirs(&home.join(".codex/sessions")).await {
        for month in child_dirs(&year).await {
            for day in child_dirs(&month).await {
                files.extend(jsonl_files(&day).await);
            }
        }
    }
    files
}

async fn list_all_codex_sessions(home: &Path) -> Vec<ResumableSession> {
    let mut sessions = Vec::new();
    for path in codex_session_files(home).await {
        if let Some(session) = summarize_codex_session_file(&path).await {
            sessions.push(session);
        }
    }
    sessions
}

// ---------------------------------------------------------------------
// Full transcript hydration — for resuming a session *into the UI*, not
// just handing `--resume <id>` to the CLI (which continues the session's
// context either way, but leaves Maestro's own transcript view blank
// until the next turn). Deliberately simpler than the live event stream:
// only reconstructs user/assistant text turns, not thinking blocks or
// tool calls — replaying those exactly would mean re-deriving each CLI's
// full tool_use/tool_result pairing from cold storage, which the live
// adapters (`claude.rs`/`cursor.rs`) do turn-by-turn already-in-flight,
// not from an on-disk file. Good enough to show "what was actually said"
// on resume; tool-call detail from before the resume point won't replay.
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurn {
    pub role: &'static str, // "user" | "assistant"
    pub text: String,
}

/// Extracts every `{"type":"text","text":"..."}`-shaped block's text from
/// a message's `content` array — the shape Claude's assistant turns and
/// Cursor's both use for plain text segments. Joined with blank lines so
/// multiple text blocks in one turn don't run together.
fn extract_text_blocks(value: &Value) -> Option<String> {
    let blocks = value.get("message")?.get("content")?.as_array()?;
    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}

async fn read_claude_transcript(path: &Path) -> Vec<TranscriptTurn> {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return Vec::new();
    };
    let mut lines = BufReader::new(file).lines();
    let mut turns = Vec::new();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("user") => {
                // Plain-string content only — an array means a synthetic
                // tool_result echo, not a real typed turn (same
                // distinction `summarize_claude_session_file` makes).
                if let Some(text) = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !is_claude_conversation_prompt(text) {
                        continue;
                    }
                    turns.push(TranscriptTurn {
                        role: "user",
                        text: text.to_string(),
                    });
                }
            }
            Some("assistant") => {
                if let Some(text) = extract_text_blocks(&value) {
                    turns.push(TranscriptTurn {
                        role: "assistant",
                        text,
                    });
                }
            }
            _ => {}
        }
    }
    turns
}

async fn read_cursor_transcript(path: &Path) -> Vec<TranscriptTurn> {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return Vec::new();
    };
    let mut lines = BufReader::new(file).lines();
    let mut turns = Vec::new();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("role").and_then(|r| r.as_str()) {
            Some("user") => {
                if let Some(text) = extract_cursor_user_query(&value) {
                    turns.push(TranscriptTurn { role: "user", text });
                }
            }
            Some("assistant") => {
                if let Some(text) = extract_text_blocks(&value) {
                    turns.push(TranscriptTurn {
                        role: "assistant",
                        text,
                    });
                }
            }
            _ => {}
        }
    }
    turns
}

async fn read_codex_transcript(path: &Path) -> Vec<TranscriptTurn> {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return Vec::new();
    };
    let mut lines = BufReader::new(file).lines();
    let mut turns = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match payload.get("type").and_then(Value::as_str) {
            Some("user_message") => {
                if let Some(text) = payload.get("message").and_then(Value::as_str) {
                    turns.push(TranscriptTurn {
                        role: "user",
                        text: text.to_string(),
                    });
                }
            }
            Some("agent_message") => {
                if let Some(text) = payload.get("message").and_then(Value::as_str) {
                    turns.push(TranscriptTurn {
                        role: "assistant",
                        text: text.to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    turns
}

async fn find_global_session_file(
    home: &Path,
    kind: AgentKind,
    session_id: &str,
) -> Option<PathBuf> {
    match kind {
        AgentKind::ClaudeCode => {
            for project in child_dirs(&home.join(".claude/projects")).await {
                let candidate = project.join(format!("{session_id}.jsonl"));
                if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
                    return Some(candidate);
                }
            }
        }
        AgentKind::CursorAgent => {
            for project in child_dirs(&home.join(".cursor/projects")).await {
                let dir = project.join("agent-transcripts").join(session_id);
                if let Some(path) = jsonl_files(&dir).await.into_iter().next() {
                    return Some(path);
                }
            }
        }
        AgentKind::Codex => {
            for path in codex_session_files(home).await {
                if path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.ends_with(session_id))
                {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Locates the on-disk transcript file for `session_id` and parses it
/// into ordered user/assistant turns. Empty (not an error) if the
/// session/file can't be found — mirrors `list_for_worktree`'s "unknown
/// is honest, not a guess" stance, since Codex has no known on-disk
/// layout to read from at all yet.
pub async fn read_transcript(
    kind: AgentKind,
    worktree_root: &str,
    session_id: &str,
) -> Vec<TranscriptTurn> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let direct = match kind {
        AgentKind::ClaudeCode => {
            let path = PathBuf::from(&home)
                .join(".claude/projects")
                .join(sanitize_cwd(worktree_root))
                .join(format!("{session_id}.jsonl"));
            tokio::fs::try_exists(&path)
                .await
                .unwrap_or(false)
                .then_some(path)
        }
        AgentKind::CursorAgent => {
            let base = PathBuf::from(&home)
                .join(".cursor/projects")
                .join(sanitize_cwd(worktree_root))
                .join("agent-transcripts")
                .join(session_id);
            jsonl_files(&base).await.into_iter().next()
        }
        AgentKind::Codex => None,
    };
    let path = match direct {
        Some(path) => Some(path),
        None => find_global_session_file(Path::new(&home), kind, session_id).await,
    };
    match (kind, path) {
        (AgentKind::ClaudeCode, Some(path)) => read_claude_transcript(&path).await,
        (AgentKind::CursorAgent, Some(path)) => read_cursor_transcript(&path).await,
        (AgentKind::Codex, Some(path)) => read_codex_transcript(&path).await,
        (_, None) => Vec::new(),
    }
}

#[tauri::command]
pub async fn get_session_transcript(
    kind: AgentKind,
    worktree_root: String,
    session_id: String,
) -> Result<Vec<TranscriptTurn>, String> {
    Ok(read_transcript(kind, &worktree_root, &session_id).await)
}

async fn list_for_worktree(kind: AgentKind, worktree_root: &str) -> Vec<ResumableSession> {
    match kind {
        AgentKind::ClaudeCode => list_claude_sessions(worktree_root).await,
        AgentKind::CursorAgent => list_cursor_sessions(worktree_root).await,
        AgentKind::Codex => match std::env::var("HOME") {
            Ok(home) => list_all_codex_sessions(Path::new(&home))
                .await
                .into_iter()
                .filter(|session| session.worktree_root == worktree_root)
                .collect(),
            Err(_) => Vec::new(),
        },
    }
}

#[tauri::command]
pub async fn list_all_resumable_sessions(kind: AgentKind) -> Result<Vec<ResumableSession>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let home = Path::new(&home);
    let mut sessions = match kind {
        AgentKind::ClaudeCode => list_all_claude_sessions(home).await,
        AgentKind::CursorAgent => list_all_cursor_sessions(home).await,
        AgentKind::Codex => list_all_codex_sessions(home).await,
    };
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn list_resumable_sessions(
    kind: AgentKind,
    worktree_root: String,
) -> Result<Vec<ResumableSession>, String> {
    Ok(list_for_worktree(kind, &worktree_root).await)
}

/// Same as `list_resumable_sessions`, but across every worktree the
/// caller passes in (typically every worktree in the active project) —
/// the "Resume a session" list shouldn't be blind to a session just
/// because it happened in a sibling worktree rather than the one
/// currently active. Each returned session carries its own
/// `worktree_root` so the caller knows which worktree to resume it
/// against.
#[tauri::command]
pub async fn list_resumable_sessions_for_roots(
    kind: AgentKind,
    worktree_roots: Vec<String>,
) -> Result<Vec<ResumableSession>, String> {
    let mut all = Vec::new();
    for root in worktree_roots {
        all.extend(list_for_worktree(kind, &root).await);
    }
    all.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::is_claude_conversation_prompt;

    #[test]
    fn excludes_claude_local_command_wrappers() {
        assert!(!is_claude_conversation_prompt(
            "<local-command-caveat>Caveat: generated locally</local-command-caveat>"
        ));
        assert!(!is_claude_conversation_prompt(
            "<command-name>/doctor</command-name>"
        ));
        assert!(is_claude_conversation_prompt(
            "Diagnose why the build is failing"
        ));
    }
}
