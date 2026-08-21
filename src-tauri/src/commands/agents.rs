use crate::agents::one_shot;
use crate::agents::registry::{self, AgentKind, CliStatus};
use crate::git;
use crate::process_ext::{resolve_executable, HiddenCommandExt};
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

/// The binary a given CLI should actually be spawned as: the user's
/// override if they set one, otherwise the default name resolved via PATH.
///
/// Every spawn site goes through this — detection, one-shots, and turns —
/// so that a path configured in Settings means the same thing everywhere.
pub fn binary_path_for(conn: &rusqlite::Connection, kind: AgentKind) -> Result<String, String> {
    Ok(read_binary_override(conn, kind)?.unwrap_or_else(|| kind.default_binary().to_string()))
}

/// The stored binary-path override, if any. `pub(crate)` because the
/// OpenCode commands re-detect after auth changes and need the same
/// override chain detection uses.
pub(crate) fn read_binary_override(
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

    let mut status = registry::detect(kind, binary_override).await;
    // Aider's "auth" is a question about Maestro's own settings rather
    // than about the binary — it has no login of its own, so being ready
    // means having a provider configured. `registry::detect` can't answer
    // that (it holds no database connection), so it leaves a placeholder
    // and the real answer is filled in here.
    if kind == AgentKind::Aider && status.installed {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let (auth_state, detail) = aider_auth_state(&conn);
        status.auth_state = auth_state;
        status.auth_detail = detail;
    }
    {
        let mut cache = state.agent_status_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(kind, status.clone());
    }
    Ok(status)
}

/// Whether Aider has somewhere to send a request.
///
/// Reports the *names* of what's configured rather than a bare
/// "authenticated", because with Aider that is the genuinely useful fact:
/// a user with an OpenRouter key and a DeepSeek key needs to know which
/// models they can actually reach.
fn aider_auth_state(conn: &rusqlite::Connection) -> (registry::AuthState, Option<String>) {
    use crate::agents::aider::credentials;
    let ready: Vec<&str> = credentials::enabled_providers(conn)
        .into_iter()
        .filter(|provider| credentials::is_configured(conn, provider))
        .map(|provider| provider.display_name)
        .collect();

    if ready.is_empty() {
        return (
            registry::AuthState::NotAuthenticated,
            Some("No LLM provider configured yet — add one in Settings → Agents.".to_string()),
        );
    }
    (
        registry::AuthState::Authenticated,
        Some(format!("Connected to {}", ready.join(", "))),
    )
}

#[tauri::command]
pub async fn detect_all_agent_clis(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<CliStatus>, String> {
    let [claude_kind, codex_kind, cursor_kind, aider_kind, opencode_kind] = AgentKind::all();
    let (claude, codex, cursor, aider, opencode) = tokio::join!(
        detect_agent_cli(state.clone(), claude_kind, force),
        detect_agent_cli(state.clone(), codex_kind, force),
        detect_agent_cli(state.clone(), cursor_kind, force),
        detect_agent_cli(state.clone(), aider_kind, force),
        detect_agent_cli(state.clone(), opencode_kind, force),
    );
    Ok(vec![claude?, codex?, cursor?, aider?, opencode?])
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

// `Deserialize` as well as `Serialize` because Aider's OpenRouter catalog
// is cached to disk between launches as a list of these (see
// `agents/aider/catalog.rs`) — 414 models is not worth re-fetching on
// every mount of the model picker.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub supported_efforts: Vec<String>,
    pub supports_thinking: bool,
    pub supports_fast: bool,
    pub variants: Vec<ModelVariant>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
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
        AgentKind::OpenCode => list_opencode_models(&state).await,
        AgentKind::CursorAgent => {
            let binary_path = {
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                read_binary_override(&conn, kind)?
                    .unwrap_or_else(|| kind.default_binary().to_string())
            };
            let output = tokio::process::Command::new(resolve_executable(&binary_path))
                .arg("--list-models")
                .stdin(Stdio::null())
                .hide_window()
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Ok(Vec::new());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let mut families: BTreeMap<String, ModelOption> = BTreeMap::new();
            for line in text.lines() {
                // `cursor-agent` colours `--list-models` even when its
                // stdout is a pipe, so the raw line reads
                // `\x1b[36mauto\x1b[39m \x1b[2m- Auto\x1b[22m`. The
                // separator this splits on is then never literally " - "
                // and every model was silently dropped, leaving the picker
                // empty. Strip the escapes before parsing.
                let line = crate::agents::strip_ansi(line);
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
            let output =
                tokio::process::Command::new(resolve_executable(AgentKind::Codex.default_binary()))
                    .args(["debug", "models"])
                    .stdin(Stdio::null())
                    .hide_window()
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
        // Aider's list is the union of every configured provider's
        // catalog. Nothing is offered for a provider the user hasn't set
        // up, because selecting it would only produce an auth error at the
        // first turn.
        AgentKind::Aider => {
            use crate::agents::aider::{catalog, credentials};

            let (binary_path, providers, envs) = {
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                let binary_path = read_binary_override(&conn, kind)?
                    .unwrap_or_else(|| kind.default_binary().to_string());
                let providers = credentials::enabled_providers(&conn);
                let envs: Vec<_> = providers
                    .iter()
                    .map(|provider| credentials::resolve_env(&conn, provider).unwrap_or_default())
                    .collect();
                (binary_path, providers, envs)
            };

            let app_data_dir = state.app_data_dir.clone();
            let mut models = Vec::new();
            for (provider, env) in providers.iter().zip(envs.iter()) {
                // One unreachable provider — a stopped Ollama server, say —
                // must not blank the whole picker, so failures are skipped
                // rather than propagated.
                match catalog::list_models(provider, env, &binary_path, &app_data_dir).await {
                    Ok(found) => models.extend(found),
                    Err(message) => {
                        log::warn!("aider: couldn't list {} models: {message}", provider.id)
                    }
                }
            }
            Ok(models)
        }
    }
}

const COMMIT_MESSAGE_PROMPT_PREFIX: &str = "Write a git commit message for the following staged changes.\n\nRules:\n- First line: a concise imperative summary, at most 72 characters, no trailing period.\n- If the change needs more explanation than the summary allows, add a blank line then a short body written as bullet points describing what changed and, where it isn't obvious from the diff alone, why.\n- Base the message on the actual files and code touched below — name the specific component, function, or behavior that changed rather than a generic description like \"update files\" or \"fix bug\".\n- Match the style (Conventional Commits or plain) of the recent commit messages listed below — don't go looking for more history than what's given here.\n- Do not run any commands or use any tools. Everything you need is already provided below; just answer directly.\n- Reply with ONLY the commit message text itself — no commentary on what you're doing or checking, no code fences, no quotes around it.\n\n";

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

    // Handed to the model directly so it never needs to go check history
    // itself — that self-directed check is exactly what was leaking as
    // narration ("Checking recent commit history for style...") into the
    // final message text despite the "no commentary" rule above.
    let recent_subjects: Vec<String> = git::log(&worktree_path, 5, 0)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.message)
        .collect();
    let recent_history = if recent_subjects.is_empty() {
        "Recent commit messages: none (this is the first commit) — use plain style.\n".to_string()
    } else {
        let list = recent_subjects
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("Recent commit messages (for style reference only):\n{list}\n")
    };

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

    let prompt = format!(
        "{COMMIT_MESSAGE_PROMPT_PREFIX}{recent_history}\nFiles changed (from `git diff --staged --stat`):\n{stat}\n\nFull diff:\n{truncated}"
    );
    let message = one_shot::run_one_shot(kind, &binary_path, &prompt, &worktree_root).await?;
    Ok(message.trim().to_string())
}

/// OpenCode's model options: one entry per connected provider's model,
/// labeled `Provider · Model` so the composer's flat searchable menu
/// self-groups under search without bespoke grouping UI.
///
/// Source priority: the managed sidecar's `/config/providers` when it is
/// already running (rich names, authoritative connected set), else
/// `opencode models` — which needs no server at all, so opening a
/// model picker never boots one (§2.2). The CLI fallback's labels are
/// the raw `provider/model` ids; plainer than the sidecar path, equally
/// honest.
async fn list_opencode_models(state: &State<'_, AppState>) -> Result<Vec<ModelOption>, String> {
    // `try_acquire_running`, not `endpoint()` directly: this holds a
    // guard for the duration of the HTTP calls below, so a server that's
    // already up can't be pulled out from under this request by the idle
    // reaper mid-flight — while still never starting one on its own.
    if let Some((endpoint, _guard)) = state.opencode_sidecar.try_acquire_running() {
        let timeout = std::time::Duration::from_secs(15);
        let config =
            crate::agents::opencode::client::get_json_for(&endpoint, "/config/providers", timeout)
                .await;
        let provider_list =
            crate::agents::opencode::client::get_json_for(&endpoint, "/provider", timeout)
                .await
                .unwrap_or_else(|_| serde_json::json!({}));
        if let Ok(config) = config {
            let names: std::collections::HashMap<String, String> = provider_list
                .pointer("/all")
                .and_then(|v| v.as_array())
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            Some((
                                entry.get("id")?.as_str()?.to_string(),
                                entry.get("name")?.as_str()?.to_string(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut models: Vec<ModelOption> = Vec::new();
            for entry in config
                .get("providers")
                .and_then(|v| v.as_array())
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let provider_name = names.get(id).map(String::as_str).unwrap_or(id);
                for (model_id, model) in entry
                    .get("models")
                    .and_then(|m| m.as_object())
                    .map(std::collections::BTreeMap::from_iter)
                    .unwrap_or_default()
                {
                    let display = model
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(model_id.as_str());
                    models.push(simple_model(
                        &format!("{id}/{model_id}"),
                        &format!("{provider_name} · {display}"),
                        &[],
                    ));
                }
            }
            return Ok(models);
        }
    }

    // Fallback: plain id list from the CLI, no server required.
    let binary_path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        binary_path_for(&conn, AgentKind::OpenCode)?
    };
    let output = tokio::process::Command::new(resolve_executable(&binary_path))
        .args(["models"])
        .stdin(Stdio::null())
        .hide_window()
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| line.contains('/'))
        .map(|id| simple_model(id, id, &[]))
        .collect())
}
