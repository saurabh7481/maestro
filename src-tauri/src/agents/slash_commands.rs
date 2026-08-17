//! Discovers what a "/word" typed in the composer could resolve to.
//!
//! Two different kinds of list feed this, and it matters which is which:
//!
//! - **Discovered** (Claude Code only): real, on-disk custom skills and
//!   commands — never a guessed list of *built-in* command names, since
//!   there's no non-interactive way to enumerate the CLI's own built-ins
//!   (confirmed against `claude --help` — no flag surfaces them).
//! - **Built-in** (both CLIs): a hardcoded list, deliberately not
//!   file-discovered because there's nothing on disk to discover it
//!   from. Every entry below was live-verified against the exact
//!   installed CLI version rather than guessed from memory or docs:
//!   - Claude Code (2.1.224): each one tested through the *real* pipeline
//!     `claude.rs::build_turn` actually uses (`--input-format stream-json
//!     --output-format stream-json`), confirming it comes back as a
//!     normal `assistant`/`result` event pair — i.e. it renders in
//!     Maestro's transcript exactly like any other reply, no special
//!     handling needed. Candidates that instead came back
//!     `"/x isn't available in this environment"` (interactive-TUI-only:
//!     `/permissions`, `/memory`, `/hooks`, `/vim`, `/resume`, `/theme`,
//!     …) or `"Unknown command"` (doesn't exist in this version:
//!     `/pr-comments`, `/todos`, `/privacy`) were excluded — offering
//!     either would just be a dead click.
//!   - Cursor Agent (2026.08.11-e8db854): unlike Claude, none of its
//!     commands are locally intercepted in `--print` mode — even
//!     `/clear` measurably hits the model (real `duration_api_ms`/cost,
//!     not the instant zero-cost Claude gives). Its rich menu is
//!     rendered by the interactive TUI, which isn't reachable
//!     headlessly (see `list_slash_commands`'s doc for why); this list
//!     is instead transcribed from a live screenshot of that menu,
//!     restricted to the entries that read as CLI-standard rather than
//!     this particular team's cloud-synced custom commands (a
//!     `/search-company-knowledge`-style entry wouldn't exist for a
//!     different Maestro user). Selecting one sends its slug as the
//!     message text — the same thing typing it by hand already does,
//!     just discoverable now.
//!
//! Codex has neither: not installed anywhere this project could confirm
//! either list against a real binary.

use crate::agents::registry::AgentKind;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandOption {
    /// What typing after "/" and selecting this inserts, e.g.
    /// `"superset:automate"` or `"review-pr"` — the caller prepends the
    /// leading "/".
    pub slug: String,
    pub description: String,
    pub source: &'static str, // "skill" | "command" | "builtin"
}

/// See the module doc's Claude Code bullet for how this list was
/// verified. `/init` and `/review` are real commands but — unlike the
/// rest — trigger genuine agentic work (tool calls, a cloud job) rather
/// than an instant local lookup, same cost profile as sending any other
/// message; still included since they're legitimate, just not "free."
const CLAUDE_BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("clear", "Start a new conversation, clearing history"),
    ("compact", "Compact the conversation to free up context"),
    (
        "cost",
        "Show token usage and your Claude usage-limit status",
    ),
    ("context", "Show what's using up the context window"),
    (
        "mcp",
        "List configured MCP servers and their connection status",
    ),
    ("model", "Show or switch the active model"),
    ("agents", "Show how to create or manage subagents"),
    ("init", "Analyze the codebase and generate a CLAUDE.md"),
    ("review", "Run a cloud-hosted multi-agent code review"),
];

/// See the module doc's Cursor Agent bullet — transcribed from a live
/// screenshot of the interactive TUI's menu, CLI-standard entries only.
const CURSOR_BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("commit", "Ask the agent to stage and commit changes"),
    ("command", "Manage custom commands"),
    (
        "ask",
        "Toggle ask mode (Q&A, read-only; no edits or command execution)",
    ),
    (
        "plan",
        "Iterate on an implementation plan before code changes",
    ),
    ("summarize", "Summarize the conversation to reduce context"),
    (
        "changes",
        "Review changes — conversation, unstaged, staged, and committed",
    ),
    (
        "simplify",
        "Find low-info comments, one-off helpers, perf issues, and reuse opportunities",
    ),
];

/// Pulls flat `key: value` fields out of a `---\n...\n---` frontmatter
/// block — hand-rolled rather than pulling in a YAML crate, since every
/// skill/command file actually observed here uses only that flat shape,
/// not anything needing YAML's full grammar.
fn parse_frontmatter(text: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return fields;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    fields
}

fn walk_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_md_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
        }
    }
}

async fn find_md_files(root: &Path) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        walk_md_files(&root, &mut files);
        files
    })
    .await
    .unwrap_or_default()
}

/// Skills live at `<skills_root>/<name>/SKILL.md` (flat, user-authored)
/// or `<skills_root>/<plugin>/skills/<name>/SKILL.md` (plugin-provided,
/// invoked as `/plugin:name`) — confirmed by directly comparing this
/// machine's installed plugin skills against the slug Claude Code's own
/// UI uses for them. A `SKILL.md` at any other depth doesn't match
/// either known shape and is skipped rather than guessed at.
fn skill_slug(skills_root: &Path, skill_md: &Path) -> Option<String> {
    let rel = skill_md.strip_prefix(skills_root).ok()?;
    let parts: Vec<&str> = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    match parts.as_slice() {
        [name, "SKILL.md"] => Some((*name).to_string()),
        [plugin, "skills", name, "SKILL.md"] => Some(format!("{plugin}:{name}")),
        _ => None,
    }
}

async fn collect_skills(skills_root: &Path, out: &mut Vec<SlashCommandOption>) {
    for path in find_md_files(skills_root).await {
        if path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
            continue;
        }
        let Some(slug) = skill_slug(skills_root, &path) else {
            continue;
        };
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let description = parse_frontmatter(&text)
            .get("description")
            .cloned()
            .unwrap_or_default();
        out.push(SlashCommandOption {
            slug,
            description,
            source: "skill",
        });
    }
}

/// Custom commands live at `<commands_root>/<name>.md` (invoked as
/// `/name`) or nested `<commands_root>/<dir>/<name>.md` (invoked as
/// `/dir:name`) — Claude Code's documented custom-slash-command layout.
async fn collect_commands(commands_root: &Path, out: &mut Vec<SlashCommandOption>) {
    for path in find_md_files(commands_root).await {
        let Ok(rel) = path.strip_prefix(commands_root) else {
            continue;
        };
        let mut parts: Vec<String> = rel
            .components()
            .filter_map(|c| c.as_os_str().to_str().map(str::to_string))
            .collect();
        let Some(last) = parts.last_mut() else {
            continue;
        };
        *last = last.trim_end_matches(".md").to_string();
        let slug = parts.join(":");

        let text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        let description = parse_frontmatter(&text)
            .get("description")
            .cloned()
            .unwrap_or_default();
        out.push(SlashCommandOption {
            slug,
            description,
            source: "command",
        });
    }
}

/// Project-level entries are collected first, then user-level, then the
/// verified built-ins — combined with `dedup_by` running after a
/// *stable* sort, that makes a project skill/command win over a
/// same-named user-level one, and either win over a same-named built-in,
/// instead of the other way around: project customization should shadow
/// a personal default, and either should be able to intentionally
/// override a built-in's name rather than being silently blocked by it.
async fn list_for_claude(worktree_root: &str) -> Vec<SlashCommandOption> {
    let mut out = Vec::new();
    let worktree = PathBuf::from(worktree_root);
    collect_skills(&worktree.join(".claude/skills"), &mut out).await;
    collect_commands(&worktree.join(".claude/commands"), &mut out).await;

    if let Ok(home) = std::env::var("HOME") {
        collect_skills(&PathBuf::from(&home).join(".claude/skills"), &mut out).await;
        collect_commands(&PathBuf::from(&home).join(".claude/commands"), &mut out).await;
    }

    out.extend(
        CLAUDE_BUILTIN_COMMANDS
            .iter()
            .map(|(slug, description)| SlashCommandOption {
                slug: slug.to_string(),
                description: description.to_string(),
                source: "builtin",
            }),
    );

    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out.dedup_by(|a, b| a.slug == b.slug);
    out
}

fn list_for_cursor() -> Vec<SlashCommandOption> {
    CURSOR_BUILTIN_COMMANDS
        .iter()
        .map(|(slug, description)| SlashCommandOption {
            slug: slug.to_string(),
            description: description.to_string(),
            source: "builtin",
        })
        .collect()
}

#[tauri::command]
pub async fn list_slash_commands(
    kind: AgentKind,
    worktree_root: String,
) -> Result<Vec<SlashCommandOption>, String> {
    Ok(match kind {
        AgentKind::ClaudeCode => list_for_claude(&worktree_root).await,
        AgentKind::CursorAgent => list_for_cursor(),
        AgentKind::Codex => Vec::new(),
        // Aider's slash commands (/add, /ask, /undo, ...) are
        // interpreted inside its own REPL and aren't reachable from
        // the `--message` one-shot invocation Maestro uses.
        AgentKind::Aider => Vec::new(),
    })
}
