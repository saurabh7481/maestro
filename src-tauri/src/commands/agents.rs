use crate::agents::one_shot;
use crate::agents::registry::{self, AgentKind, CliStatus};
use crate::git;
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::State;

fn settings_key(kind: AgentKind) -> String {
    format!("agent.{}.binary_path", kind.slug())
}

fn read_binary_override(
    conn: &rusqlite::Connection,
    kind: AgentKind,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value_json FROM settings WHERE key = ?1",
        params![settings_key(kind)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|json| serde_json::from_str::<String>(&json).map_err(|e| e.to_string()))
    .transpose()
}

/// Detects one CLI, respecting a stored binary-path override, and caches
/// the result in `AppState` so repeated mounts of Settings/the new-tab
/// menu don't re-shell out — the centralized availability service every
/// other feature reads from. `force` bypasses the cache (the UI's
/// "Recheck" button).
#[tauri::command]
pub async fn detect_agent_cli(
    state: State<'_, AppState>,
    kind: AgentKind,
    force: bool,
) -> Result<CliStatus, String> {
    if !force {
        let cached = {
            let cache = state.agent_status_cache.lock().map_err(|e| e.to_string())?;
            cache.get(&kind).cloned()
        };
        if let Some(status) = cached {
            return Ok(status);
        }
    }

    let binary_override = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        read_binary_override(&conn, kind)?
    };

    let status = registry::detect(kind, binary_override).await;
    {
        let mut cache = state.agent_status_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(kind, status.clone());
    }
    Ok(status)
}

#[tauri::command]
pub async fn detect_all_agent_clis(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<CliStatus>, String> {
    let [claude_kind, codex_kind, cursor_kind] = AgentKind::all();
    let (claude, codex, cursor) = tokio::join!(
        detect_agent_cli(state.clone(), claude_kind, force),
        detect_agent_cli(state.clone(), codex_kind, force),
        detect_agent_cli(state.clone(), cursor_kind, force),
    );
    Ok(vec![claude?, codex?, cursor?])
}

#[tauri::command]
pub async fn set_agent_binary_path(
    state: State<'_, AppState>,
    kind: AgentKind,
    path: Option<String>,
) -> Result<(), String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        match &path {
            Some(p) => {
                let value_json = serde_json::to_string(p).map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                    params![settings_key(kind), value_json],
                )
                .map_err(|e| e.to_string())?;
            }
            None => {
                conn.execute(
                    "DELETE FROM settings WHERE key = ?1",
                    params![settings_key(kind)],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    // Invalidate the cache so the next read reflects the new path instead
    // of a stale "not installed" (or stale-valid) result.
    let mut cache = state.agent_status_cache.lock().map_err(|e| e.to_string())?;
    cache.remove(&kind);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub supported_efforts: Vec<String>,
    pub supports_thinking: bool,
    pub supports_fast: bool,
    pub variants: Vec<ModelVariant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVariant {
    pub id: String,
    pub effort: Option<String>,
    pub thinking: bool,
    pub fast: bool,
}

fn simple_model(id: &str, label: &str, efforts: &[&str]) -> ModelOption {
    ModelOption {
        id: id.to_string(),
        label: label.to_string(),
        supported_efforts: efforts.iter().map(|value| (*value).to_string()).collect(),
        supports_thinking: false,
        supports_fast: false,
        variants: Vec::new(),
    }
}

fn cursor_variant(id: &str) -> (String, Option<String>, bool, bool) {
    let mut base = id.to_string();
    let fast = base.strip_suffix("-fast").is_some();
    if fast {
        base.truncate(base.len() - "-fast".len());
    }
    let thinking = base.contains("-thinking");
    base = base.replace("-thinking", "");
    let mut effort = None;
    for value in [
        "extra-high",
        "xhigh",
        "medium",
        "high",
        "low",
        "none",
        "max",
    ] {
        if let Some(stripped) = base.strip_suffix(&format!("-{value}")) {
            base = stripped.to_string();
            effort = Some(
                if value == "extra-high" {
                    "xhigh"
                } else {
                    value
                }
                .to_string(),
            );
            break;
        }
    }
    (base, effort, thinking, fast)
}

fn cursor_family_label(label: &str) -> String {
    let mut clean = label.replace(" 1M", "");
    for suffix in [
        " Extra High",
        " Medium",
        " High",
        " Low",
        " None",
        " Max",
        " Thinking",
        " Fast",
    ] {
        clean = clean.replace(suffix, "");
    }
    clean
}

/// "Model/mode pickers shown only if the installed CLI version exposes
/// them" (docs/V1_SCOPE.md §6 — no fake dropdowns). Claude's aliases are
/// a fixed, confirmed-real set (`claude --help`'s `--model`); Cursor's
/// come from its own `--list-models` (a real, working, non-interactive
/// command — confirmed live) rather than a guessed static list, so it
/// stays accurate as Cursor adds/removes models; Codex gets no picker at
/// all rather than a guess, since no equivalent was confirmed.
#[tauri::command]
pub async fn list_agent_models(
    state: State<'_, AppState>,
    kind: AgentKind,
) -> Result<Vec<ModelOption>, String> {
    match kind {
        AgentKind::ClaudeCode => Ok(vec![
            simple_model(
                "sonnet",
                "Sonnet (latest)",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "claude-sonnet-5",
                "Sonnet 5",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "claude-sonnet-4-6",
                "Sonnet 4.6",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "opus",
                "Opus (latest)",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "claude-opus-5",
                "Opus 5",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "claude-opus-4-8",
                "Opus 4.8",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "claude-opus-4-7",
                "Opus 4.7",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "fable",
                "Fable (latest)",
                &["low", "medium", "high", "xhigh", "max"],
            ),
            simple_model(
                "claude-fable-5",
                "Fable 5",
                &["low", "medium", "high", "xhigh", "max"],
            ),
        ]),
        AgentKind::CursorAgent => {
            let binary_path = {
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                read_binary_override(&conn, kind)?
                    .unwrap_or_else(|| kind.default_binary().to_string())
            };
            let output = tokio::process::Command::new(&binary_path)
                .arg("--list-models")
                .stdin(Stdio::null())
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Ok(Vec::new());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let mut families: BTreeMap<String, ModelOption> = BTreeMap::new();
            for line in text.lines() {
                let line = line.trim();
                let Some((id, label)) = line.split_once(" - ") else {
                    continue;
                };
                if id.is_empty() {
                    continue;
                }
                let (base, effort, thinking, fast) = cursor_variant(id.trim());
                let family = families.entry(base.clone()).or_insert_with(|| ModelOption {
                    id: base,
                    label: cursor_family_label(label.trim()),
                    supported_efforts: Vec::new(),
                    supports_thinking: false,
                    supports_fast: false,
                    variants: Vec::new(),
                });
                if let Some(value) = &effort {
                    if !family.supported_efforts.contains(value) {
                        family.supported_efforts.push(value.clone());
                    }
                }
                family.supports_thinking |= thinking;
                family.supports_fast |= fast;
                family.variants.push(ModelVariant {
                    id: id.trim().to_string(),
                    effort,
                    thinking,
                    fast,
                });
            }
            Ok(families.into_values().collect())
        }
        AgentKind::Codex => {
            let output = tokio::process::Command::new(AgentKind::Codex.default_binary())
                .args(["debug", "models"])
                .stdin(Stdio::null())
                .output()
                .await
                .map_err(|e| e.to_string())?;
            let value: serde_json::Value =
                serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
            let models = value
                .get("models")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter(|model| model.get("visibility").and_then(|v| v.as_str()) == Some("list"))
                .filter_map(|model| {
                    let id = model.get("slug")?.as_str()?.to_string();
                    let label = model
                        .get("display_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let supported_efforts = model
                        .get("supported_reasoning_levels")
                        .and_then(|v| v.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|level| {
                            level
                                .get("effort")
                                .and_then(|v| v.as_str())
                                .map(str::to_string)
                        })
                        .collect();
                    let supports_fast = model
                        .get("additional_speed_tiers")
                        .and_then(|v| v.as_array())
                        .is_some_and(|tiers| {
                            tiers.iter().any(|tier| tier.as_str() == Some("fast"))
                        });
                    Some(ModelOption {
                        id,
                        label,
                        supported_efforts,
                        supports_thinking: false,
                        supports_fast,
                        variants: Vec::new(),
                    })
                })
                .collect();
            Ok(models)
        }
    }
}

const COMMIT_MESSAGE_PROMPT_PREFIX: &str = "Write a git commit message for the following staged changes.\n\nRules:\n- First line: a concise imperative summary, at most 72 characters, no trailing period.\n- If the change needs more explanation than the summary allows, add a blank line then a short body written as bullet points describing what changed and, where it isn't obvious from the diff alone, why.\n- Base the message on the actual files and code touched below — name the specific component, function, or behavior that changed rather than a generic description like \"update files\" or \"fix bug\".\n- Follow Conventional Commits style (e.g. `feat:`, `fix:`, `refactor:`) only if the existing commit history already uses it; otherwise plain style.\n- Reply with ONLY the commit message text — no commentary, no code fences, no quotes around it.\n\nFiles changed (from `git diff --staged --stat`):\n";

/// The concrete cross-feature use case that motivated centralizing agent
/// availability: draft a commit message from the *already-staged* diff.
/// Uses `one_shot::run_one_shot` (no tool permissions needed at all — the
/// diff is inlined into the prompt, so this sidesteps the whole
/// permission-protocol question each interactive adapter under
/// `agents/` has to solve).
#[tauri::command]
pub async fn generate_commit_message(
    state: State<'_, AppState>,
    kind: AgentKind,
    worktree_root: String,
) -> Result<String, String> {
    let worktree_path = PathBuf::from(&worktree_root);
    let diff = git::staged_diff_text(&worktree_path).await?;
    if diff.trim().is_empty() {
        return Err("Nothing is staged — stage some changes first.".to_string());
    }
    let stat = git::staged_diff_stat(&worktree_path)
        .await
        .unwrap_or_default();

    let binary_path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        read_binary_override(&conn, kind)?.unwrap_or_else(|| kind.default_binary().to_string())
    };

    // Diffs can be large; keep the prompt bounded rather than risking a
    // context-limit error on a giant staged change. Truncates on a char
    // boundary, not a raw byte index — the diff can contain multi-byte
    // UTF-8 (non-ASCII identifiers, comments, strings), and slicing mid
    // character panics instead of truncating.
    const MAX_DIFF_CHARS: usize = 20_000;
    let truncated: String = match diff.char_indices().nth(MAX_DIFF_CHARS) {
        Some((byte_idx, _)) => format!("{}\n… (diff truncated)", &diff[..byte_idx]),
        None => diff,
    };

    let prompt = format!("{COMMIT_MESSAGE_PROMPT_PREFIX}{stat}\n\nFull diff:\n{truncated}");
    let message = one_shot::run_one_shot(kind, &binary_path, &prompt, &worktree_root).await?;
    Ok(message.trim().to_string())
}
