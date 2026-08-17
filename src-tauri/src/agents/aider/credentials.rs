//! Storage for the provider credentials declared in `providers.rs`.
//!
//! Two stores, split by sensitivity:
//!
//! * `FieldKind::Secret` values go to the **OS keychain** (Keychain on
//!   macOS, Credential Manager on Windows, Secret Service on Linux).
//! * `FieldKind::Plain` values — base URLs, regions, project ids — go to
//!   the ordinary `settings` table, because they are configuration rather
//!   than secrets and being able to read them back is useful.
//!
//! ## Why not just put keys in `settings` too
//!
//! `settings` is a plaintext SQLite table in the app data directory. An
//! API key there is readable by anything that can read the file, and would
//! end up in backups and support bundles. The keychain is the only place a
//! desktop app can put a secret without inventing its own crypto.
//!
//! ## When there is no keychain
//!
//! Linux Secret Service needs a running daemon, which headless sessions,
//! some minimal window managers, and some sandboxed AppImage environments
//! don't have. When that happens this module returns
//! `CredentialError::NoBackend` and Maestro **does not fall back to
//! plaintext** — it tells the user, and points them at Aider's own
//! `--env-file`/config, which is a deliberate choice they can make rather
//! than a silent downgrade of a promise the UI already made.

use crate::agents::aider::providers::{self, AiderProvider, FieldKind};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

const KEYCHAIN_SERVICE: &str = "maestro.aider";

#[derive(Debug)]
pub enum CredentialError {
    /// No OS keychain is reachable. Carries the underlying reason so the
    /// UI can show the real cause rather than a generic failure.
    NoBackend(String),
    Db(String),
    Other(String),
}

impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CredentialError::NoBackend(detail) => write!(
                f,
                "No OS keychain is available, so provider keys can't be stored securely ({detail}). \
                 Configure this provider in Aider's own config instead \
                 (~/.aider.conf.yml or a .env file)."
            ),
            CredentialError::Db(detail) => write!(f, "Settings database error: {detail}"),
            CredentialError::Other(detail) => write!(f, "{detail}"),
        }
    }
}

impl From<CredentialError> for String {
    fn from(value: CredentialError) -> Self {
        value.to_string()
    }
}

type Result<T> = std::result::Result<T, CredentialError>;

/// Keychain entries are per provider *and* per field, because a provider
/// can need more than one secret (Bedrock needs both halves of an AWS key
/// pair).
fn entry(provider_id: &str, env_var: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("{provider_id}.{env_var}"))
        .map_err(|e| CredentialError::NoBackend(e.to_string()))
}

fn plain_key(provider_id: &str, env_var: &str) -> String {
    format!("agent.aider.provider.{provider_id}.{env_var}")
}

fn enabled_key(provider_id: &str) -> String {
    format!("agent.aider.provider.{provider_id}.enabled")
}

/// Whether the OS keychain works at all, probed by round-tripping a value
/// through a throwaway entry.
///
/// Probing by *writing* rather than reading is deliberate: on Linux a
/// Secret Service connection can open successfully and still refuse to
/// store anything when the keyring is locked, and discovering that at the
/// moment the user saves their first API key is a worse experience than
/// discovering it when the settings pane opens.
pub fn keychain_available() -> std::result::Result<(), String> {
    let probe = keyring::Entry::new(KEYCHAIN_SERVICE, "__probe__").map_err(|e| e.to_string())?;
    probe.set_password("probe").map_err(|e| e.to_string())?;
    let _ = probe.delete_credential();
    Ok(())
}

pub fn store_secret(provider_id: &str, env_var: &str, value: &str) -> Result<()> {
    let entry = entry(provider_id, env_var)?;
    if value.is_empty() {
        // Treat clearing as deletion so a blank field doesn't leave an
        // empty-string key behind that reads as "configured".
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(value)
        .map_err(|e| CredentialError::NoBackend(e.to_string()))
}

pub fn load_secret(provider_id: &str, env_var: &str) -> Result<Option<String>> {
    match entry(provider_id, env_var)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CredentialError::NoBackend(e.to_string())),
    }
}

pub fn delete_secret(provider_id: &str, env_var: &str) -> Result<()> {
    match entry(provider_id, env_var)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CredentialError::NoBackend(e.to_string())),
    }
}

pub fn store_plain(conn: &Connection, provider_id: &str, env_var: &str, value: &str) -> Result<()> {
    let key = plain_key(provider_id, env_var);
    if value.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(|e| CredentialError::Db(e.to_string()))?;
        return Ok(());
    }
    let value_json =
        serde_json::to_string(value).map_err(|e| CredentialError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, value_json],
    )
    .map_err(|e| CredentialError::Db(e.to_string()))?;
    Ok(())
}

pub fn load_plain(conn: &Connection, provider_id: &str, env_var: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value_json FROM settings WHERE key = ?1",
        params![plain_key(provider_id, env_var)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| CredentialError::Db(e.to_string()))?
    .map(|json| {
        serde_json::from_str::<String>(&json).map_err(|e| CredentialError::Other(e.to_string()))
    })
    .transpose()
}

pub fn set_enabled(conn: &Connection, provider_id: &str, enabled: bool) -> Result<()> {
    let key = enabled_key(provider_id);
    if !enabled {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(|e| CredentialError::Db(e.to_string()))?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key],
    )
    .map_err(|e| CredentialError::Db(e.to_string()))?;
    Ok(())
}

pub fn is_enabled(conn: &Connection, provider_id: &str) -> bool {
    conn.query_row(
        "SELECT value_json FROM settings WHERE key = ?1",
        params![enabled_key(provider_id)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|value| value == "true")
}

pub fn enabled_providers(conn: &Connection) -> Vec<&'static AiderProvider> {
    providers::all()
        .iter()
        .filter(|p| is_enabled(conn, p.id))
        .collect()
}

/// Every value a provider has stored, keyed by environment variable.
///
/// Missing secrets are simply absent rather than an error: a provider can
/// legitimately have optional secret fields (Ollama's API key), and a
/// half-configured provider needs to be reportable, not fatal.
pub fn resolve_env(
    conn: &Connection,
    provider: &AiderProvider,
) -> Result<HashMap<&'static str, String>> {
    let mut env = HashMap::new();
    for field in provider.fields {
        let value = match field.kind {
            FieldKind::Secret => load_secret(provider.id, field.env_var)?,
            FieldKind::Plain => load_plain(conn, provider.id, field.env_var)?,
        };
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            env.insert(field.env_var, value);
        }
    }
    Ok(env)
}

/// A provider is configured when every *required* field has a value.
pub fn is_configured(conn: &Connection, provider: &AiderProvider) -> bool {
    let Ok(env) = resolve_env(conn, provider) else {
        return false;
    };
    provider
        .fields
        .iter()
        .filter(|f| f.required)
        .all(|f| env.contains_key(f.env_var))
}

/// The environment for a turn: the credentials of the provider that owns
/// `model`, and nothing else.
///
/// Injecting only the owning provider's variables — rather than every
/// configured provider's — is what keeps the OpenAI-compatible family
/// (OpenAI, GitHub Copilot, custom endpoints) from overwriting each
/// other's `OPENAI_API_BASE` at spawn time. `providers.rs` additionally
/// refuses to enable two conflicting providers at once, so this is a
/// second line of defence rather than the only one.
pub fn env_for_model(conn: &Connection, model: Option<&str>) -> Vec<(String, String)> {
    let Some(model) = model else {
        return Vec::new();
    };
    let Some(provider) = providers::provider_for_model(model) else {
        return Vec::new();
    };
    if !is_enabled(conn, provider.id) {
        return Vec::new();
    }
    resolve_env(conn, provider)
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn plain_values_round_trip_and_clear() {
        let conn = memory_db();
        store_plain(&conn, "ollama", "OLLAMA_API_BASE", "http://localhost:11434").unwrap();
        assert_eq!(
            load_plain(&conn, "ollama", "OLLAMA_API_BASE")
                .unwrap()
                .as_deref(),
            Some("http://localhost:11434")
        );
        store_plain(&conn, "ollama", "OLLAMA_API_BASE", "").unwrap();
        assert_eq!(
            load_plain(&conn, "ollama", "OLLAMA_API_BASE").unwrap(),
            None
        );
    }

    #[test]
    fn enabling_is_off_by_default_and_toggles() {
        let conn = memory_db();
        assert!(!is_enabled(&conn, "openrouter"));
        set_enabled(&conn, "openrouter", true).unwrap();
        assert!(is_enabled(&conn, "openrouter"));
        set_enabled(&conn, "openrouter", false).unwrap();
        assert!(!is_enabled(&conn, "openrouter"));
    }

    #[test]
    fn env_for_model_is_empty_for_unknown_or_disabled_providers() {
        let conn = memory_db();
        // Unknown prefix.
        assert!(env_for_model(&conn, Some("mystery/model")).is_empty());
        // Known prefix but the provider was never enabled.
        assert!(env_for_model(&conn, Some("openrouter/anthropic/claude-x")).is_empty());
        // No model selected at all.
        assert!(env_for_model(&conn, None).is_empty());
    }

    #[test]
    fn a_provider_with_unfilled_required_fields_is_not_configured() {
        let conn = memory_db();
        let azure = providers::by_id("azure").unwrap();
        assert!(!is_configured(&conn, azure));
        // Filling only the plain fields still leaves the secret missing.
        store_plain(
            &conn,
            "azure",
            "AZURE_API_BASE",
            "https://x.openai.azure.com",
        )
        .unwrap();
        store_plain(&conn, "azure", "AZURE_API_VERSION", "2024-12-01-preview").unwrap();
        assert!(!is_configured(&conn, azure));
    }
}
