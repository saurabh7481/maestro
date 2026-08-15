//! Single-turn, no-tools prompt→text execution shared by every
//! cross-feature use of an agent CLI that isn't a full interactive tab —
//! currently just commit-message generation (`commands/agents.rs`), but
//! deliberately generic (see the plan's centralization requirement).
//! Implemented for all three CLIs, unlike the interactive adapter which
//! is Claude Code only for this phase — this is `ROADMAP.md` Phase 6
//! agents' *simplest* code path, proven now rather than deferred.

use crate::agents::registry::AgentKind;
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const ONE_SHOT_TIMEOUT: Duration = Duration::from_secs(120);

fn build_command(kind: AgentKind, binary_path: &str, prompt: &str) -> Command {
    let mut command = Command::new(binary_path);
    match kind {
        AgentKind::ClaudeCode => {
            // `--tools ""` disables all tools outright — this call only
            // ever needs a text completion (the prompt already embeds
            // whatever context it needs, e.g. a staged diff), so there's
            // nothing to gate and no permission-protocol concern at all.
            command
                .args(["--print", "--output-format", "json", "--tools", ""])
                .arg(prompt);
        }
        AgentKind::CursorAgent => {
            // `--mode ask`: read-only Q&A, the closest fit — confirmed
            // live. `--trust` is required even for this: non-interactive
            // mode refuses to run at all without it (see
            // `cursor_agent.rs`'s module doc) — this call silently
            // produced zero output before this flag was added.
            command
                .args([
                    "--print",
                    "--output-format",
                    "json",
                    "--mode",
                    "ask",
                    "--trust",
                ])
                .arg(prompt);
        }
        AgentKind::Codex => {
            // Unverified — Codex isn't installed anywhere this project
            // could test against (see `codex.rs`'s module doc). Best
            // effort only; `extract_result_text` below falls back to raw
            // stdout if the expected shape isn't there.
            command.args(["exec", "--json", prompt]);
        }
    }
    command.stdin(Stdio::null());
    command
}

fn extract_result_text(kind: AgentKind, stdout: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(stdout);
    match kind {
        AgentKind::ClaudeCode | AgentKind::CursorAgent => {
            // `--output-format json` → one JSON object with a `result`
            // string field for both CLIs — confirmed live for each
            // independently (Claude: Phase 5's spike; Cursor: Phase 6's).
            let value: Value = serde_json::from_str(text.trim())
                .map_err(|e| format!("couldn't parse {}'s output: {e}", kind.display_name()))?;
            value
                .get("result")
                .and_then(|r| r.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("{} returned no result text", kind.display_name()))
        }
        AgentKind::Codex => {
            // Exact field names unverified (Codex's NDJSON shape wasn't
            // captured live — see `codex.rs`'s module doc). Try the
            // plausible keys, and fall back to raw stdout rather than
            // failing outright if none match, so a shape mismatch
            // degrades to "slightly messy text" instead of "broken
            // feature".
            for line in text.lines().rev() {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                for key in ["result", "text", "response", "message"] {
                    if let Some(s) = value.get(key).and_then(|v| v.as_str()) {
                        return Ok(s.to_string());
                    }
                }
            }
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Err(format!("{} produced no output", kind.display_name()))
            } else {
                Ok(trimmed.to_string())
            }
        }
    }
}

pub async fn run_one_shot(
    kind: AgentKind,
    binary_path: &str,
    prompt: &str,
    cwd: &str,
) -> Result<String, String> {
    let mut command = build_command(kind, binary_path, prompt);
    command.current_dir(cwd);

    let output = tokio::time::timeout(ONE_SHOT_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{} timed out", kind.display_name()))?
        .map_err(|e| format!("failed to run {}: {e}", kind.display_name()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{} exited with an error", kind.display_name())
        } else {
            stderr
        });
    }

    extract_result_text(kind, &output.stdout)
}
