//! OpenCode auth detection, answered from disk.
//!
//! ## Why a file read and not the server
//!
//! "Is opencode ready?" must be answerable without spawning anything —
//! `registry::detect` runs at startup and on every Settings mount, and
//! docs/OPENCODE_INTEGRATION.md §2.2's rule is that detection never
//! acquires the sidecar (a ~366 MB server must not boot because a
//! settings pane rendered). opencode persists its credentials in a plain
//! JSON file (`~/.local/share/opencode/auth.json`, verified 1.18.19), so
//! the fast path is reading it directly.
//!
//! The trade-off is that the file's shape is opencode's private detail,
//! not a documented contract. Parsing is therefore defensive by design:
//! any surprise degrades to [`AuthState::Unknown`] with the file path in
//! the detail — never to a guessed "authenticated". When the sidecar
//! happens to be running anyway, Phase O4's provider pane cross-checks
//! against `GET /provider`'s authoritative `connected` list; this module
//! stays the no-process answer.

use crate::agents::registry::AuthState;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Where opencode keeps provider credentials. `$XDG_DATA_HOME` first,
/// then the Linux default — matching opencode's own resolution order on
/// this platform. (Windows uses a different base; Maestro is
/// Linux-first and this returns `None` there rather than a guess.)
pub fn auth_json_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
            if !data_home.is_empty() {
                return Some(PathBuf::from(data_home).join("opencode").join("auth.json"));
            }
        }
        std::env::var("HOME")
            .ok()
            .filter(|home| !home.is_empty())
            .map(|home| PathBuf::from(home).join(".local/share/opencode/auth.json"))
    }
}

/// Classify one file's contents. The map's *keys* are the provider ids;
/// values hold key/token material this deliberately never inspects.
fn classify(raw: Option<&str>, path: &Path) -> (AuthState, Option<String>) {
    let Some(raw) = raw else {
        return (
            AuthState::NotAuthenticated,
            Some("No providers connected yet — add one to use OpenCode.".to_string()),
        );
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (
            AuthState::Unknown,
            Some(format!(
                "{} is not valid JSON — it may be mid-write.",
                path.display()
            )),
        );
    };
    let count = value
        .as_object()
        .map(|providers| providers.keys().filter(|id| !id.is_empty()).count());
    match count {
        None => (
            // A list or string where the map should be is opencode's
            // problem, but reporting "authenticated" off it would be
            // Maestro's fault.
            AuthState::Unknown,
            Some(format!("{} has an unexpected shape.", path.display())),
        ),
        Some(0) => (
            AuthState::NotAuthenticated,
            Some("No providers connected yet — add one to use OpenCode.".to_string()),
        ),
        Some(1) => (
            AuthState::Authenticated,
            Some(format!(
                "Connected to {}.",
                value
                    .as_object()
                    .and_then(|providers| providers.keys().next())
                    .map(String::as_str)
                    .unwrap_or_default()
            )),
        ),
        Some(n) => (
            AuthState::Authenticated,
            Some(format!("Connected to {n} providers.")),
        ),
    }
}

/// The auth answer for the settings card and availability gating. Async
/// (`tokio::fs`, not `std::fs`) since this runs on the async runtime —
/// called from `registry::probe_auth` on every detection pass, including
/// every Settings pane mount — and a blocking read, however small the
/// file, is still a blocking call on a tokio worker thread.
pub async fn auth_state_from_disk() -> (AuthState, Option<String>) {
    let Some(path) = auth_json_path() else {
        return (
            AuthState::Unknown,
            Some("Cannot locate opencode's credentials file on this platform.".to_string()),
        );
    };
    let raw = tokio::fs::read_to_string(&path).await.ok();
    classify(raw.as_deref(), &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> &'static Path {
        Path::new("/home/x/.local/share/opencode/auth.json")
    }

    #[test]
    fn zen_only_counts_as_authenticated() {
        // Shape captured from the dev machine's real auth.json (value
        // redacted); the key material itself is never read.
        let (state, detail) = classify(
            Some(r#"{"opencode":{"type":"api","key":"sk-redacted"}}"#),
            path(),
        );
        assert_eq!(state, AuthState::Authenticated);
        assert!(detail.unwrap_or_default().contains("opencode"));
    }

    #[test]
    fn oauth_shaped_entries_count_too() {
        // GitHub Copilot stores refresh tokens, not api keys — the entry
        // shape differs and must still count.
        let (state, _) = classify(
            Some(r#"{"github-copilot":{"type":"oauth","refresh":"r","access":"a","expires":1}}"#),
            path(),
        );
        assert_eq!(state, AuthState::Authenticated);
    }

    #[test]
    fn empty_object_is_not_authenticated() {
        let (state, detail) = classify(Some("{}"), path());
        assert_eq!(state, AuthState::NotAuthenticated);
        assert!(detail.unwrap_or_default().contains("No providers"));
    }

    #[test]
    fn missing_file_is_not_authenticated() {
        let (state, detail) = classify(None, path());
        assert_eq!(state, AuthState::NotAuthenticated);
        assert!(detail.unwrap_or_default().contains("No providers"));
    }

    #[test]
    fn malformed_json_is_unknown_not_guessed() {
        let (state, detail) = classify(Some("{oops"), path());
        assert_eq!(state, AuthState::Unknown);
        assert!(detail.unwrap_or_default().contains("not valid JSON"));
    }

    #[test]
    fn non_object_json_is_unknown_not_authenticated() {
        let (state, _) = classify(Some("[]"), path());
        assert_eq!(state, AuthState::Unknown);
    }

    #[cfg(not(windows))]
    #[test]
    fn default_path_lands_under_xdg_or_home() {
        std::env::remove_var("XDG_DATA_HOME");
        let path = auth_json_path().expect("home-based fallback");
        assert!(path
            .to_string_lossy()
            .contains(".local/share/opencode/auth.json"));
    }
}
