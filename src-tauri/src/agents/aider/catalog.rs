//! Turning a configured provider into a list of pickable models.
//!
//! Dispatches on the provider's declared `Catalog` strategy — see
//! `providers.rs` for why one strategy isn't enough.
//!
//! ## On effort levels
//!
//! `ModelOption::supported_efforts` drives whether the composer shows an
//! effort dial, so populating it with a guess would put a control on
//! screen that silently does nothing — exactly what docs/V1_SCOPE.md §6
//! forbids. Only OpenRouter tells us the truth (each model lists its
//! `supported_parameters`, and `reasoning` appears on 283 of 414 models at
//! time of writing), so only OpenRouter models get efforts. Everywhere
//! else the list is empty and the dial stays hidden.

use crate::agents::aider::providers::{AiderProvider, Catalog, LocalShape};
use crate::commands::agents::ModelOption;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Matches Aider's own OpenRouter cache TTL (`aider/openrouter.py`).
const CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 24);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn model_option(id: String, label: String, efforts: Vec<String>) -> ModelOption {
    ModelOption {
        id,
        label,
        supported_efforts: efforts,
        supports_thinking: false,
        supports_fast: false,
        variants: Vec::new(),
    }
}

// ---------------------------------------------------------------- OpenRouter

#[derive(Deserialize)]
struct OpenRouterResponse {
    data: Vec<OpenRouterModel>,
}

#[derive(Deserialize)]
struct OpenRouterModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    supported_parameters: Vec<String>,
}

/// Where the fetched OpenRouter catalog is cached between launches.
///
/// Deliberately *not* Aider's own `~/.aider/caches/openrouter_models.json`:
/// that file is Aider's to manage, and writing into another tool's cache
/// to save one HTTP request would be a nasty surprise for anyone
/// debugging Aider itself.
fn cache_path(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join("aider-openrouter-models.json")
}

async fn read_cache(path: &std::path::Path) -> Option<Vec<ModelOption>> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let age = metadata.modified().ok()?.elapsed().ok()?;
    if age > CACHE_TTL {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn write_cache(path: &std::path::Path, models: &[ModelOption]) {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(bytes) = serde_json::to_vec(models) {
        let _ = tokio::fs::write(path, bytes).await;
    }
}

/// OpenRouter's `/api/v1/models` is public — no key required to browse the
/// catalog, which is why the picker can be populated before the user has
/// finished pasting their key.
async fn fetch_openrouter(url: &str, prefix: &str) -> Result<Vec<ModelOption>, String> {
    let response = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("OpenRouter returned HTTP {}", response.status()));
    }
    let parsed: OpenRouterResponse = response.json().await.map_err(|e| e.to_string())?;

    let mut models: Vec<ModelOption> = parsed
        .data
        .into_iter()
        .map(|model| {
            // `reasoning` in supported_parameters is the only honest
            // signal that an effort dial will do anything.
            let efforts = if model.supported_parameters.iter().any(|p| p == "reasoning") {
                vec!["low".to_string(), "medium".to_string(), "high".to_string()]
            } else {
                Vec::new()
            };
            let label = model.name.clone().unwrap_or_else(|| model.id.clone());
            model_option(format!("{prefix}{}", model.id), label, efforts)
        })
        .collect();
    models.sort_by_key(|model| model.label.to_lowercase());
    Ok(models)
}

// -------------------------------------------------------------- Local servers

#[derive(Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaTag>,
}

#[derive(Deserialize)]
struct OllamaTag {
    name: String,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

async fn fetch_local(
    base: &str,
    path: &str,
    shape: LocalShape,
    prefix: &str,
) -> Result<Vec<ModelOption>, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let response = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} returned HTTP {}", response.status()));
    }

    let mut ids: Vec<String> = match shape {
        LocalShape::OllamaTags => {
            let parsed: OllamaTagsResponse = response.json().await.map_err(|e| e.to_string())?;
            parsed.models.into_iter().map(|m| m.name).collect()
        }
        LocalShape::OpenAiModels => {
            let parsed: OpenAiModelsResponse = response.json().await.map_err(|e| e.to_string())?;
            parsed.data.into_iter().map(|m| m.id).collect()
        }
    };
    ids.sort();
    Ok(ids
        .into_iter()
        .map(|id| model_option(format!("{prefix}{id}"), id.clone(), Vec::new()))
        .collect())
}

// ------------------------------------------------------------- LiteLLM table

/// Asks the installed Aider for LiteLLM's bundled model table.
///
/// `--no-git` is not optional: without it Aider will initialise a git repo
/// and append `.aider*` to `.gitignore` in whatever directory it is run
/// from, which is a startling thing for a settings pane to do. Confirmed
/// against aider 0.86.2.
async fn fetch_litellm(binary_path: &str, prefix: &str) -> Result<Vec<ModelOption>, String> {
    let output = tokio::process::Command::new(binary_path)
        .args(["--no-git", "--list-models", prefix])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Couldn't run {binary_path}: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut models: Vec<ModelOption> = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- "))
        .map(|id| id.trim())
        .filter(|id| id.starts_with(prefix))
        .map(|id| {
            let label = id.strip_prefix(prefix).unwrap_or(id).to_string();
            model_option(id.to_string(), label, Vec::new())
        })
        .collect();
    models.sort_by(|a, b| a.label.cmp(&b.label));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

// ------------------------------------------------------------------ Dispatch

/// Models for one provider. `env` supplies the provider's resolved
/// credentials, which local catalogs need for their base URL.
pub async fn list_models(
    provider: &AiderProvider,
    env: &HashMap<&'static str, String>,
    binary_path: &str,
    app_data: &std::path::Path,
) -> Result<Vec<ModelOption>, String> {
    match provider.catalog {
        Catalog::PublicHttp { url } => {
            let path = cache_path(app_data);
            if let Some(cached) = read_cache(&path).await {
                return Ok(cached);
            }
            let models = fetch_openrouter(url, provider.model_prefix).await?;
            write_cache(&path, &models).await;
            Ok(models)
        }
        Catalog::LocalHttp {
            base_field,
            path,
            shape,
        } => {
            let base = env.get(base_field).ok_or_else(|| {
                format!("{} needs its server URL set first.", provider.display_name)
            })?;
            fetch_local(base, path, shape, provider.model_prefix).await
        }
        Catalog::LitellmDb => fetch_litellm(binary_path, provider.model_prefix).await,
        // Nothing to enumerate — the UI shows the hint and a free-text
        // field instead of a list.
        Catalog::Manual { .. } => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_models_parse_with_efforts_only_where_reasoning_is_supported() {
        let body = r#"{"data":[
            {"id":"anthropic/claude-x","name":"Anthropic: Claude X",
             "supported_parameters":["tools","reasoning"]},
            {"id":"meta/llama-y","name":"Meta: Llama Y",
             "supported_parameters":["tools"]}
        ]}"#;
        let parsed: OpenRouterResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.data.len(), 2);
        assert!(parsed.data[0]
            .supported_parameters
            .iter()
            .any(|p| p == "reasoning"));
        assert!(!parsed.data[1]
            .supported_parameters
            .iter()
            .any(|p| p == "reasoning"));
    }

    #[test]
    fn openrouter_models_tolerate_missing_optional_fields() {
        // The live API carries ~18 fields; we deserialize 3. A model
        // missing `name` or `supported_parameters` must not fail the whole
        // catalog.
        let parsed: OpenRouterResponse =
            serde_json::from_str(r#"{"data":[{"id":"bare/model"}]}"#).unwrap();
        assert_eq!(parsed.data[0].id, "bare/model");
        assert!(parsed.data[0].name.is_none());
        assert!(parsed.data[0].supported_parameters.is_empty());
    }

    /// Hits OpenRouter's real endpoint. Ignored by default so the suite
    /// stays offline and deterministic; run with
    /// `cargo test -- --ignored openrouter_catalog_is_reachable`.
    #[tokio::test]
    #[ignore = "network"]
    async fn openrouter_catalog_is_reachable() {
        let models = fetch_openrouter("https://openrouter.ai/api/v1/models", "openrouter/")
            .await
            .expect("fetch failed");
        // The whole reason this provider doesn't use `LitellmDb`: the live
        // catalog is far bigger than the bundled table's 112 entries.
        assert!(models.len() > 200, "only got {} models", models.len());
        assert!(models.iter().all(|m| m.id.starts_with("openrouter/")));
        // And some, but not all, genuinely support a reasoning dial.
        assert!(models.iter().any(|m| !m.supported_efforts.is_empty()));
        assert!(models.iter().any(|m| m.supported_efforts.is_empty()));
    }

    /// Shells out to a real Aider. Ignored by default since it needs the
    /// binary installed.
    #[tokio::test]
    #[ignore = "needs aider installed"]
    async fn litellm_catalog_reads_the_bundled_table() {
        let models = fetch_litellm("aider", "deepseek/")
            .await
            .expect("aider run failed");
        assert!(!models.is_empty());
        assert!(models.iter().all(|m| m.id.starts_with("deepseek/")));
        // The label drops the prefix that the id carries.
        assert!(models.iter().all(|m| !m.label.starts_with("deepseek/")));
    }

    #[test]
    fn local_server_shapes_parse() {
        let ollama: OllamaTagsResponse =
            serde_json::from_str(r#"{"models":[{"name":"llama3:8b"},{"name":"qwen:7b"}]}"#)
                .unwrap();
        assert_eq!(ollama.models.len(), 2);
        assert_eq!(ollama.models[0].name, "llama3:8b");

        let lm: OpenAiModelsResponse =
            serde_json::from_str(r#"{"data":[{"id":"local-model"}]}"#).unwrap();
        assert_eq!(lm.data[0].id, "local-model");
    }
}
