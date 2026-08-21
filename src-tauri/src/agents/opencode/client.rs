//! Loopback HTTP access to the managed `opencode serve` sidecar.
//!
//! Every request carries the per-boot basic-auth password the supervisor
//! generated (`OPENCODE_SERVER_PASSWORD`), so a random local process that
//! finds the port still can't read — or spend — the user's provider
//! credentials. Phase O1 verified that `GET /provider` responses contain
//! live API keys, which is what makes the password mandatory rather than
//! optional hardening (docs/OPENCODE_INTEGRATION.md §7).
//!
//! Deliberately minimal: typed response structs live with their features
//! (provider management in Phase O4), not here. This module only knows
//! how to reach the server and fetch JSON.

use serde_json::Value;
use std::time::Duration;

/// opencode's own default basic-auth username; we only rotate the
/// password side.
pub const USERNAME: &str = "opencode";

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub password: String,
}

impl Endpoint {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

async fn send(
    endpoint: &Endpoint,
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let mut request = client(timeout)?
        .request(method, url)
        .basic_auth(USERNAME, Some(&endpoint.password));
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
        .send()
        .await
        .map_err(|e| format!("opencode sidecar request failed: {e}"))
}

/// First line of an error body — enough for a toast, small enough not to
/// dump a whole HTML error page into one.
pub async fn error_detail(response: reqwest::Response) -> String {
    response
        .text()
        .await
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

async fn get_json(endpoint: &Endpoint, path: &str, timeout: Duration) -> Result<Value, String> {
    let url = format!("{}{path}", endpoint.base_url());
    let response = send(endpoint, reqwest::Method::GET, &url, None, timeout).await?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("opencode sidecar read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "opencode sidecar returned {status}: {}",
            body.lines().next().unwrap_or("").trim()
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("opencode sidecar sent invalid JSON: {e}"))
}

/// Generic JSON GET for management endpoints (provider lists, auth
/// methods). Callers project the result — raw responses carry key
/// material and must never cross IPC.
pub(crate) async fn get_json_for(
    endpoint: &Endpoint,
    path: &str,
    timeout: Duration,
) -> Result<Value, String> {
    get_json(endpoint, path, timeout).await
}

/// Generic JSON POST returning the parsed body.
pub(crate) async fn post_json(
    endpoint: &Endpoint,
    url: &str,
    body: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let response = send(endpoint, reqwest::Method::POST, url, Some(body), timeout).await?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("opencode sidecar read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "opencode sidecar returned {status}: {}",
            text.lines().next().unwrap_or("").trim()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("opencode sidecar sent invalid JSON: {e}"))
}

/// Generic request for status-only verbs (PUT/DELETE), returning the
/// response for success checks.
pub(crate) async fn request(
    endpoint: &Endpoint,
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    send(endpoint, method, url, body, timeout).await
}

/// One health probe. The supervisor polls this until the server reports
/// healthy or the boot budget runs out (measured boot: 1–2 s; budget:
/// 10 s, §2.3 of the plan).
pub async fn healthy(endpoint: &Endpoint) -> Result<bool, String> {
    let value = get_json(endpoint, "/global/health", Duration::from_secs(2)).await?;
    Ok(value
        .get("healthy")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_loopback_with_port() {
        let endpoint = Endpoint {
            port: 4096,
            password: "pw".to_string(),
        };
        assert_eq!(endpoint.base_url(), "http://127.0.0.1:4096");
    }

    #[tokio::test]
    async fn health_check_rejects_wrong_password() {
        // A real HTTP round trip against a socket that isn't an opencode
        // server: connection refused is the expected failure, and it must
        // come back as an Err rather than a panic or a false "healthy".
        let endpoint = Endpoint {
            port: 1, // nothing listens on port 1
            password: "pw".to_string(),
        };
        assert!(healthy(&endpoint).await.is_err());
    }
}
