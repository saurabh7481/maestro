//! Tauri commands for configuring Aider's LLM providers.
//!
//! The settings pane is generic over `agents/aider/providers.rs` — it
//! renders whatever fields a provider declares — so these commands are
//! deliberately provider-agnostic too. Adding a provider means adding a
//! literal to that registry and nothing here changes.

use crate::agents::aider::credentials;
use crate::agents::aider::providers::{self, AiderProvider, CredentialField, FieldKind};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// A provider plus everything the settings UI needs to render and judge it.
///
/// Secret *values* are never included — only whether one is present. An
/// API key that has been stored is shown as configured, never echoed back,
/// so the window can't become a way to read keys out of the keychain.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: &'static str,
    pub display_name: &'static str,
    pub model_prefix: &'static str,
    pub docs_url: &'static str,
    /// The provider's key console, for the "Get API key" button.
    pub console_url: Option<&'static str>,
    pub note: Option<&'static str>,
    pub fields: Vec<ProviderFieldStatus>,
    pub catalog: providers::Catalog,
    pub enabled: bool,
    /// Every required field has a value.
    pub configured: bool,
    /// Providers that can't be enabled at the same time as this one
    /// because they'd write to the same environment variables.
    pub conflicts_with: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFieldStatus {
    pub env_var: &'static str,
    pub label: &'static str,
    pub kind: FieldKind,
    pub required: bool,
    pub placeholder: Option<&'static str>,
    /// Non-secret values are returned so the user can see and edit them.
    /// Secrets never are.
    pub value: Option<String>,
    /// Whether a secret is stored. Always `false` for plain fields, which
    /// report through `value` instead.
    pub has_secret: bool,
}

fn field_status(
    conn: &rusqlite::Connection,
    provider: &AiderProvider,
    field: &'static CredentialField,
) -> ProviderFieldStatus {
    let (value, has_secret) = match field.kind {
        FieldKind::Plain => (
            credentials::load_plain(conn, provider.id, field.env_var).unwrap_or(None),
            false,
        ),
        FieldKind::Secret => (
            None,
            credentials::load_secret(provider.id, field.env_var)
                .unwrap_or(None)
                .is_some_and(|value| !value.is_empty()),
        ),
    };
    ProviderFieldStatus {
        env_var: field.env_var,
        label: field.label,
        kind: field.kind,
        required: field.required,
        placeholder: field.placeholder,
        value,
        has_secret,
    }
}

#[tauri::command]
pub async fn list_aider_providers(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    Ok(providers::all()
        .iter()
        .map(|provider| ProviderStatus {
            id: provider.id,
            display_name: provider.display_name,
            model_prefix: provider.model_prefix,
            docs_url: provider.docs_url,
            console_url: provider.console_url,
            note: provider.note,
            fields: provider
                .fields
                .iter()
                .map(|field| field_status(&conn, provider, field))
                .collect(),
            catalog: provider.catalog,
            enabled: credentials::is_enabled(&conn, provider.id),
            configured: credentials::is_configured(&conn, provider),
            conflicts_with: provider.conflicts_with(),
        })
        .collect())
}

/// Whether secrets can be stored at all on this machine.
///
/// Surfaced to the UI so the provider pane can say up front that keys
/// can't be saved, rather than letting the user type one in and fail on
/// save. See `credentials.rs` for why there is no plaintext fallback.
#[tauri::command]
pub async fn aider_keychain_status() -> Result<Option<String>, String> {
    Ok(credentials::keychain_available().err())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderRequest {
    pub provider_id: String,
    /// Field values keyed by environment variable. A field left out is
    /// unchanged; a field present but empty is cleared.
    pub values: std::collections::HashMap<String, String>,
    pub enabled: bool,
}

#[tauri::command]
pub async fn save_aider_provider(
    state: State<'_, AppState>,
    request: SaveProviderRequest,
) -> Result<(), String> {
    let provider = providers::by_id(&request.provider_id)
        .ok_or_else(|| format!("Unknown provider: {}", request.provider_id))?;

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;

        // Two providers sharing an environment variable would silently
        // cross-configure each other — enabling OpenAI alongside a custom
        // OpenAI-compatible endpoint would point one at the other's URL.
        // Refuse rather than let that happen quietly.
        if request.enabled {
            for other_id in provider.conflicts_with() {
                if credentials::is_enabled(&conn, other_id) {
                    let other = providers::by_id(other_id)
                        .map(|p| p.display_name)
                        .unwrap_or(other_id);
                    return Err(format!(
                        "{} and {} both authenticate through the same environment variables, so only one can be enabled at a time. Turn off {} first.",
                        provider.display_name, other, other
                    ));
                }
            }
        }

        for field in provider.fields {
            let Some(value) = request.values.get(field.env_var) else {
                continue;
            };
            match field.kind {
                FieldKind::Secret => credentials::store_secret(provider.id, field.env_var, value)?,
                FieldKind::Plain => {
                    credentials::store_plain(&conn, provider.id, field.env_var, value)?
                }
            }
        }
        credentials::set_enabled(&conn, provider.id, request.enabled)?;
    }

    // Aider's readiness is derived from provider configuration, so the
    // cached detection result is now stale.
    let mut cache = state.agent_status_cache.lock().map_err(|e| e.to_string())?;
    cache.remove(&crate::agents::registry::AgentKind::Aider);
    Ok(())
}

#[tauri::command]
pub async fn forget_aider_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    let provider =
        providers::by_id(&provider_id).ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        for field in provider.fields {
            match field.kind {
                FieldKind::Secret => {
                    credentials::delete_secret(provider.id, field.env_var)?;
                }
                FieldKind::Plain => {
                    credentials::store_plain(&conn, provider.id, field.env_var, "")?;
                }
            }
        }
        credentials::set_enabled(&conn, provider.id, false)?;
    }
    let mut cache = state.agent_status_cache.lock().map_err(|e| e.to_string())?;
    cache.remove(&crate::agents::registry::AgentKind::Aider);
    Ok(())
}
