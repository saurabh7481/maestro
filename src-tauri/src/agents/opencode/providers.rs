//! Provider management over the sidecar's HTTP API — the in-app
//! replacement for `opencode auth login` (docs/OPENCODE_INTEGRATION.md §3).
//!
//! ## The projection rule
//!
//! Phase O1 found that `GET /provider` and `GET /config/providers`
//! include live credential material (`"key": "sk-…"`). Everything this
//! module returns to the command layer is therefore a *projected* struct
//! built field-by-field from the raw JSON — never a passthrough. A new
//! interesting-looking field on the wire does not reach the webview until
//! someone adds it to a struct here deliberately.
//!
//! ## Flow shapes (verified against 1.18.19's OpenAPI spec)
//!
//! - API key: `PUT /auth/{id}` with `{type: "api", key}`.
//! - OAuth: `POST /provider/{id}/oauth/authorize` with
//!   `{method: <index>, inputs}` → `{url, method: "auto"|"code",
//!   instructions}`. "auto" means the browser round-trips by itself;
//!   "code" shows the user a device code. Completion is detected the same
//!   way for both: poll until the provider id appears in `/provider`'s
//!   `connected` list — flow-agnostic and impossible to get wrong the way
//!   per-flow callback plumbing can be.

use crate::agents::opencode::client::{self, Endpoint};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One catalog entry — what the "Add provider" modal renders per row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
}

/// One connected provider — a pane row. `model_count`/`default_model`
/// come from `/config/providers`, which is also where the keys live;
/// only these three safe fields survive the projection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedProvider {
    pub id: String,
    pub name: String,
    pub model_count: usize,
    pub default_model: Option<String>,
}

/// What the pane renders in one shot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOverview {
    pub connected: Vec<ConnectedProvider>,
    /// Catalog minus already-connected ids — the modal's rows.
    pub available: Vec<ProviderSummary>,
}

/// One declarative auth method (`GET /provider/auth`), passed through
/// because prompts describe form fields, not secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethod {
    /// Index into the provider's method list — what `oauth/authorize`
    /// wants back as `method`.
    pub index: u32,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<AuthPrompt>,
}

/// A conditional form field from the provider's own declaration
/// (e.g. Copilot's deployment-type select revealing an enterprise-URL
/// text field). Rendered generically by the connect sheet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompt {
    pub kind: String,
    pub key: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<AuthPromptOption>,
    /// Show this prompt only when `when.key`'s answer equals `when.value`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptOption {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// The OAuth start response, verbatim-safe by construction.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub url: String,
    /// `"auto"` (browser completes alone) or `"code"` (show a device code).
    pub method: String,
    pub instructions: String,
}

fn name_of(entry: &Value) -> String {
    entry
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Builds the overview from the two raw responses. Split out from the
/// HTTP calls so the projection rule is unit-testable without a server.
pub fn project_overview(provider_json: &Value, config_json: &Value) -> ProviderOverview {
    let connected_ids: Vec<String> = provider_json
        .get("connected")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut connected = Vec::new();
    let default_by_provider = config_json.get("default").cloned().unwrap_or(json!({}));
    for entry in config_json
        .get("providers")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !connected_ids.iter().any(|c| c == id) {
            continue;
        }
        connected.push(ConnectedProvider {
            id: id.to_string(),
            name: name_of(entry),
            model_count: entry
                .get("models")
                .and_then(|m| m.as_object())
                .map(|models| models.len())
                .unwrap_or(0),
            default_model: default_by_provider
                .get(id)
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    connected.sort_by_key(|provider| provider.name.to_lowercase());

    let available: Vec<ProviderSummary> = provider_json
        .get("all")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = entry.get("id")?.as_str()?;
                    if connected_ids.iter().any(|c| c == id) {
                        return None;
                    }
                    Some(ProviderSummary {
                        id: id.to_string(),
                        name: name_of(entry),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    ProviderOverview {
        connected,
        available,
    }
}

/// Projects the declarative auth-method list. `prompts` pass through
/// because they are form *descriptions*; anything resembling credential
/// material never appears in them (they ask questions, they don't hold
/// answers).
pub fn project_auth_methods(value: &Value) -> Vec<AuthMethod> {
    let Some(methods) = value.as_array() else {
        return Vec::new();
    };
    methods
        .iter()
        .enumerate()
        .map(|(index, method)| AuthMethod {
            index: index as u32,
            kind: method
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            label: method
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            prompts: method
                .get("prompts")
                .and_then(|v| v.as_array())
                .map(|prompts| {
                    prompts
                        .iter()
                        .map(|prompt| AuthPrompt {
                            kind: prompt
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            key: prompt
                                .get("key")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            message: prompt
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            placeholder: prompt
                                .get("placeholder")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            options: prompt
                                .get("options")
                                .and_then(|v| v.as_array())
                                .map(|options| {
                                    options
                                        .iter()
                                        .map(|option| AuthPromptOption {
                                            label: option
                                                .get("label")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or_default()
                                                .to_string(),
                                            value: option
                                                .get("value")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or_default()
                                                .to_string(),
                                            hint: option
                                                .get("hint")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string),
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                            when: prompt.get("when").and_then(|when| {
                                Some((
                                    when.get("key")?.as_str()?.to_string(),
                                    when.get("value")?.as_str()?.to_string(),
                                ))
                            }),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

async fn get(endpoint: &Endpoint, path: &str) -> Result<Value, String> {
    client::get_json_for(endpoint, path, REQUEST_TIMEOUT).await
}

pub async fn overview(endpoint: &Endpoint) -> Result<ProviderOverview, String> {
    let provider_json = get(endpoint, "/provider").await?;
    // `project_overview` derives the *connected* rows by joining
    // `/provider`'s connected ids against `/config/providers`'s entries
    // (for name/model-count/default-model) — so a config fetch failure
    // silently swallowed here wouldn't just mean no metadata, it would
    // drop every genuinely-connected provider from the pane outright,
    // reading as "disconnected" when a transient 500/timeout on this one
    // unrelated endpoint is all that happened. Only swallow it when
    // `/provider` (which just succeeded) agrees nothing is connected
    // anyway — that's the actual "empty pane, not an error card" case the
    // fallback exists for.
    let has_connections = provider_json
        .get("connected")
        .and_then(|v| v.as_array())
        .is_some_and(|list| !list.is_empty());
    let config_json = match get(endpoint, "/config/providers").await {
        Ok(value) => value,
        Err(_) if !has_connections => json!({}),
        Err(err) => return Err(err),
    };
    Ok(project_overview(&provider_json, &config_json))
}

pub async fn auth_methods(
    endpoint: &Endpoint,
    provider_id: &str,
) -> Result<Vec<AuthMethod>, String> {
    let value = get(endpoint, "/provider/auth").await?;
    Ok(project_auth_methods(
        value.get(provider_id).unwrap_or(&Value::Null),
    ))
}

pub async fn connect_api_key(
    endpoint: &Endpoint,
    provider_id: &str,
    key: &str,
) -> Result<(), String> {
    let url = format!("{}/auth/{provider_id}", endpoint.base_url());
    let response = client::request(
        endpoint,
        reqwest::Method::PUT,
        &url,
        Some(json!({ "type": "api", "key": key })),
        REQUEST_TIMEOUT,
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "{provider_id} rejected the key: {}",
            client::error_detail(response).await
        ))
    }
}

pub async fn begin_oauth(
    endpoint: &Endpoint,
    provider_id: &str,
    method_index: u32,
    inputs: &[(String, String)],
) -> Result<Authorization, String> {
    let url = format!(
        "{}/provider/{provider_id}/oauth/authorize",
        endpoint.base_url()
    );
    let inputs = inputs
        .iter()
        .cloned()
        .collect::<std::collections::HashMap<_, _>>();
    let value = client::post_json(
        endpoint,
        &url,
        json!({ "method": method_index, "inputs": inputs }),
        REQUEST_TIMEOUT,
    )
    .await
    .map_err(|e| format!("{provider_id} could not start its login flow: {e}"))?;
    Ok(Authorization {
        url: value
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        method: value
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        instructions: value
            .get("instructions")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Flow-agnostic completion check: did this provider turn up connected?
pub async fn is_connected(endpoint: &Endpoint, provider_id: &str) -> Result<bool, String> {
    let value = get(endpoint, "/provider").await?;
    Ok(value
        .get("connected")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().any(|id| id.as_str() == Some(provider_id)))
        .unwrap_or(false))
}

pub async fn disconnect(endpoint: &Endpoint, provider_id: &str) -> Result<(), String> {
    let url = format!("{}/auth/{provider_id}", endpoint.base_url());
    let response = client::request(
        endpoint,
        reqwest::Method::DELETE,
        &url,
        None,
        REQUEST_TIMEOUT,
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Could not remove {provider_id}: {}",
            client::error_detail(response).await
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The projection tests encode Phase O1's security finding: these
    // endpoints really do return key material, so every test payload
    // carries fake secrets that must NOT survive into the projected
    // structs.

    #[test]
    fn overview_projection_drops_key_material() {
        let provider_json = json!({
            "all": [
                {"id": "opencode", "name": "OpenCode Zen", "key": "sk-live-secret"},
                {"id": "anthropic", "name": "Anthropic", "options": {"api_key": "sk-ant-secret"}}
            ],
            "connected": ["opencode"]
        });
        let config_json = json!({
            "providers": [
                {"id": "opencode", "name": "OpenCode Zen", "apiKey": "sk-live-secret",
                 "models": {"big-pickle": {}, "other": {}}}
            ],
            "default": {"opencode": "big-pickle"}
        });

        let overview = project_overview(&provider_json, &config_json);
        let serialized = serde_json::to_string(&overview).unwrap();

        assert!(!serialized.contains("sk-live-secret"), "{serialized}");
        assert!(!serialized.contains("sk-ant-secret"), "{serialized}");
        assert_eq!(overview.connected.len(), 1);
        assert_eq!(overview.connected[0].id, "opencode");
        assert_eq!(overview.connected[0].model_count, 2);
        assert_eq!(
            overview.connected[0].default_model.as_deref(),
            Some("big-pickle")
        );
        // The unconnected catalog entry survives, minus everything but
        // its identity.
        assert_eq!(overview.available.len(), 1);
        assert_eq!(overview.available[0].id, "anthropic");
        let serialized_available = serde_json::to_string(&overview.available).unwrap();
        assert!(!serialized_available.contains("secret"));
    }

    #[test]
    fn disconnected_provider_is_not_a_connected_row() {
        // /config/providers lists recently-connected providers too; a row
        // must require presence in /provider's connected list, or a
        // just-disconnected provider would linger until restart.
        let provider_json = json!({"all": [], "connected": []});
        let config_json = json!({
            "providers": [{"id": "stale", "name": "Stale", "models": {}}],
            "default": {}
        });
        let overview = project_overview(&provider_json, &config_json);
        assert!(overview.connected.is_empty());
    }

    #[test]
    fn auth_methods_project_with_indices_and_conditional_prompts() {
        // Verbatim structure from GET /provider/auth for github-copilot.
        let value = json!([{
            "type": "oauth",
            "label": "Login with GitHub Copilot",
            "prompts": [
                {"type": "select", "key": "deploymentType",
                 "message": "Select GitHub deployment type",
                 "options": [
                     {"label": "GitHub.com", "value": "github.com", "hint": "Public"},
                     {"label": "GitHub Enterprise", "value": "enterprise"}
                 ]},
                {"type": "text", "key": "enterpriseUrl",
                 "message": "Enter your GitHub Enterprise URL or domain",
                 "placeholder": "company.ghe.com",
                 "when": {"key": "deploymentType", "op": "eq", "value": "enterprise"}}
            ]
        }]);
        let methods = project_auth_methods(&value);
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].index, 0);
        assert_eq!(methods[0].kind, "oauth");
        assert_eq!(methods[0].prompts.len(), 2);
        assert_eq!(
            methods[0].prompts[1].when.clone(),
            Some(("deploymentType".to_string(), "enterprise".to_string()))
        );
        assert_eq!(methods[0].prompts[0].options.len(), 2);
        assert_eq!(methods[0].prompts[0].options[1].hint, None);
    }

    #[test]
    fn missing_auth_entry_projects_to_no_methods() {
        assert!(project_auth_methods(&Value::Null).is_empty());
        assert!(project_auth_methods(&json!("garbage")).is_empty());
    }
}
