//! Slack's Daybook connection boundary.
//!
//! The production path is an installed Slack app using user-token OAuth
//! with PKCE. Tokens and the short-lived PKCE verifier are keychain-only;
//! SQLite stores workspace/user labels and granted scopes, never secrets.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use reqwest::header::RETRY_AFTER;
use reqwest::Url;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::state::AppState;

const OAUTH_TRANSACTION_SERVICE: &str = "maestro.daybook.slack.oauth";
const CONNECTION_SERVICE: &str = "maestro.daybook.slack.connection";
const CALLBACK_URL: &str = "maestro://oauth/slack";
const AUTHORIZE_URL: &str = "https://slack.com/oauth/v2_user/authorize";
const TOKEN_URL: &str = "https://slack.com/api/oauth.v2.user.access";
const AUTH_TEST_URL: &str = "https://slack.com/api/auth.test";
const REVOKE_URL: &str = "https://slack.com/api/auth.revoke";
const SEARCH_URL: &str = "https://slack.com/api/assistant.search.context";
const TRANSACTION_TTL_MINUTES: i64 = 10;
const MAX_SEARCH_PAGES: usize = 5;
const MAX_RATE_LIMIT_DELAY_SECONDS: u64 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackConnection {
    pub workspace_id: String,
    pub enterprise_id: Option<String>,
    pub user_id: String,
    pub workspace_name: String,
    pub display_name: String,
    pub granted_scopes: Vec<String>,
    pub status: String,
    pub connected_at: String,
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackOAuthRequest {
    #[serde(default)]
    pub include_private_channels: bool,
    #[serde(default)]
    pub include_direct_messages: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackOAuthStart {
    pub authorization_url: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackOAuthPoll {
    pub status: SlackOAuthPollStatus,
    pub connection: Option<SlackConnection>,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SlackOAuthPollStatus {
    Waiting,
    Connected,
    Failed,
}

#[derive(Debug, Clone)]
pub struct SlackActivity {
    pub id: String,
    pub occurred_at: String,
    pub text: String,
    pub context: String,
}

#[derive(Debug, Default)]
pub struct SlackCollection {
    pub items: Vec<SlackActivity>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OAuthTransaction {
    verifier: String,
    redirect_uri: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SlackCredential {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<String>,
}

struct SlackExchange {
    connection: SlackConnection,
    credential: SlackCredential,
}

#[derive(Debug, Deserialize)]
struct OAuthResponse {
    ok: bool,
    error: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    authed_user: Option<AuthedUser>,
    team: Option<OAuthTeam>,
    enterprise: Option<OAuthEnterprise>,
}

#[derive(Debug, Deserialize)]
struct AuthedUser {
    id: Option<String>,
    scope: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct OAuthTeam {
    id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthEnterprise {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthTestResponse {
    ok: bool,
    error: Option<String>,
    team: Option<String>,
    user: Option<String>,
    team_id: Option<String>,
    user_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct SearchRequest<'a> {
    query: String,
    channel_types: Vec<&'a str>,
    content_types: [&'a str; 1],
    include_context_messages: bool,
    include_bots: bool,
    after: i64,
    before: i64,
    limit: u8,
    sort: &'a str,
    sort_dir: &'a str,
    disable_semantic_search: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    ok: bool,
    error: Option<String>,
    results: Option<SearchResults>,
    response_metadata: Option<ResponseMetadata>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchResults {
    #[serde(default)]
    messages: Vec<SearchMessage>,
}

#[derive(Debug, Deserialize)]
struct SearchMessage {
    author_user_id: Option<String>,
    team_id: Option<String>,
    channel_id: Option<String>,
    channel_name: Option<String>,
    message_ts: String,
    content: String,
    permalink: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResponseMetadata {
    next_cursor: Option<String>,
}

fn client_id() -> Option<String> {
    option_env!("MAESTRO_SLACK_CLIENT_ID")
        .map(str::to_owned)
        .or_else(|| std::env::var("MAESTRO_SLACK_CLIENT_ID").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn oauth_available() -> bool {
    client_id().is_some()
}

pub fn is_slack_callback_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "maestro" && url.host_str() == Some("oauth") && url.path() == "/slack"
}

fn keychain_entry(service: &str, username: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, username)
        .map_err(|error| format!("The OS keychain is unavailable: {error}"))
}

fn store_json<T: Serialize>(service: &str, username: &str, value: &T) -> Result<(), String> {
    let encoded = serde_json::to_string(value).map_err(|error| error.to_string())?;
    keychain_entry(service, username)?
        .set_password(&encoded)
        .map_err(|error| format!("The OS keychain could not store Slack credentials: {error}"))
}

fn load_json<T: for<'de> Deserialize<'de>>(service: &str, username: &str) -> Result<T, String> {
    let encoded =
        keychain_entry(service, username)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => {
                    "The Slack sign-in request expired or was already used.".to_string()
                }
                other => format!("The OS keychain could not read Slack credentials: {other}"),
            })?;
    serde_json::from_str(&encoded).map_err(|error| error.to_string())
}

fn delete_entry(service: &str, username: &str) -> Result<(), String> {
    match keychain_entry(service, username)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "The OS keychain could not remove Slack credentials: {error}"
        )),
    }
}

async fn access_token(workspace_id: &str) -> Result<String, String> {
    let mut credential: SlackCredential = load_json(CONNECTION_SERVICE, workspace_id)?;
    let needs_refresh = credential
        .expires_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|expiry| expiry.with_timezone(&Utc) <= Utc::now() + Duration::minutes(5));
    if !needs_refresh {
        return Ok(credential.access_token);
    }
    let refresh_token = credential.refresh_token.clone().ok_or_else(|| {
        "Slack access expired and cannot be refreshed. Reconnect this workspace.".to_string()
    })?;
    let client_id =
        client_id().ok_or_else(|| "Slack OAuth is unavailable in this build.".to_string())?;
    let response = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not refresh Slack access: {error}"))?
        .json::<OAuthResponse>()
        .await
        .map_err(|error| format!("Slack returned an unreadable refresh response: {error}"))?;
    if !response.ok {
        return Err(friendly_oauth_error(
            response.error.as_deref().unwrap_or("refresh_failed"),
        ));
    }
    credential.access_token = response
        .authed_user
        .as_ref()
        .and_then(|user| user.access_token.clone())
        .or(response.access_token)
        .ok_or_else(|| "Slack refreshed access but returned no access token.".to_string())?;
    credential.refresh_token = response
        .authed_user
        .as_ref()
        .and_then(|user| user.refresh_token.clone())
        .or(response.refresh_token)
        .or(credential.refresh_token);
    let expires_in = response
        .authed_user
        .as_ref()
        .and_then(|user| user.expires_in)
        .or(response.expires_in);
    credential.expires_at =
        expires_in.map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());
    store_json(CONNECTION_SERVICE, workspace_id, &credential)?;
    Ok(credential.access_token)
}

fn search_error(code: &str, workspace_name: &str) -> String {
    let prefix = format!("{workspace_name}: ");
    match code {
        "missing_scope" => format!(
            "{prefix}the Slack token is missing a selected search permission; reconnect the workspace."
        ),
        "feature_not_enabled" | "assistant_search_context_disabled" => format!(
            "{prefix}Slack Real-time Search is not enabled for this workspace or app."
        ),
        "token_expired" | "token_revoked" | "invalid_auth" => {
            format!("{prefix}Slack access expired or was revoked; reconnect the workspace.")
        }
        "rate_limited" | "ratelimited" => {
            format!("{prefix}Slack search was rate limited; try the preview again shortly.")
        }
        _ => format!("{prefix}Slack search failed ({code})."),
    }
}

async fn collect_workspace(
    connection: &SlackConnection,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    include_private_channels: bool,
    include_direct_messages: bool,
    include_thread_context: bool,
) -> Result<(Vec<SlackActivity>, bool), String> {
    let token = access_token(&connection.workspace_id).await?;
    let after = start.timestamp();
    let before = end.timestamp();
    let mut channel_types = vec!["public_channel"];
    if include_private_channels {
        channel_types.push("private_channel");
    }
    if include_direct_messages {
        channel_types.extend(["im", "mpim"]);
    }
    // Slack's `on:` operator is evaluated in Slack's profile timezone and
    // may not match Daybook's configured timezone. The API epoch bounds are
    // authoritative, so keep the query identity-only and filter every hit.
    let query = format!("from:<@{}>", connection.user_id);
    let client = reqwest::Client::new();
    let mut cursor = None;
    let mut items = Vec::new();
    let mut truncated = false;
    for page in 0..MAX_SEARCH_PAGES {
        let payload = SearchRequest {
            query: query.clone(),
            channel_types: channel_types.clone(),
            content_types: ["messages"],
            include_context_messages: include_thread_context,
            include_bots: false,
            after,
            before,
            limit: 20,
            sort: "timestamp",
            sort_dir: "asc",
            disable_semantic_search: true,
            cursor: cursor.clone(),
        };
        let mut rate_limit_retry_used = false;
        let response = loop {
            let http_response = client
                .post(SEARCH_URL)
                .bearer_auth(&token)
                .json(&payload)
                .send()
                .await
                .map_err(|error| {
                    format!(
                        "{}: could not reach Slack search: {error}",
                        connection.workspace_name
                    )
                })?;
            if http_response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = http_response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(1);
                if rate_limit_retry_used || retry_after > MAX_RATE_LIMIT_DELAY_SECONDS {
                    return Err(format!(
                        "{}: Slack search was rate limited; retry after {} seconds.",
                        connection.workspace_name, retry_after
                    ));
                }
                rate_limit_retry_used = true;
                tokio::time::sleep(std::time::Duration::from_secs(retry_after)).await;
                continue;
            }
            break http_response
                .json::<SearchResponse>()
                .await
                .map_err(|error| {
                    format!(
                        "{}: Slack returned an unreadable search response: {error}",
                        connection.workspace_name
                    )
                })?;
        };
        if !response.ok {
            return Err(search_error(
                response.error.as_deref().unwrap_or("unknown_error"),
                &connection.workspace_name,
            ));
        }
        for message in response.results.unwrap_or_default().messages {
            if message.author_user_id.as_deref() != Some(connection.user_id.as_str()) {
                continue;
            }
            let Ok(seconds) = message
                .message_ts
                .split('.')
                .next()
                .unwrap_or_default()
                .parse::<i64>()
            else {
                continue;
            };
            if !(after..before).contains(&seconds) {
                continue;
            }
            let occurred_at = DateTime::<Utc>::from_timestamp(seconds, 0)
                .map(|value| value.to_rfc3339())
                .unwrap_or_else(|| message.message_ts.clone());
            let channel = message
                .channel_name
                .as_deref()
                .or(message.channel_id.as_deref())
                .unwrap_or("Slack conversation");
            let mut context = format!("{} · #{}", connection.workspace_name, channel);
            if let Some(permalink) = message.permalink.as_deref() {
                context.push_str(" · ");
                context.push_str(permalink);
            }
            items.push(SlackActivity {
                id: format!(
                    "{}:{}:{}",
                    message
                        .team_id
                        .as_deref()
                        .unwrap_or(&connection.workspace_id),
                    message.channel_id.as_deref().unwrap_or("unknown"),
                    message.message_ts
                ),
                occurred_at,
                text: message.content,
                context,
            });
        }
        cursor = response
            .response_metadata
            .and_then(|metadata| metadata.next_cursor)
            .filter(|value| !value.is_empty());
        if cursor.is_none() {
            break;
        }
        if page + 1 == MAX_SEARCH_PAGES {
            truncated = true;
        }
    }
    Ok((items, truncated))
}

pub async fn collect_for_day(
    connections: Vec<SlackConnection>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    include_private_channels: bool,
    include_direct_messages: bool,
    include_thread_context: bool,
) -> SlackCollection {
    let mut collection = SlackCollection::default();
    for connection in connections {
        match collect_workspace(
            &connection,
            start,
            end,
            include_private_channels,
            include_direct_messages,
            include_thread_context,
        )
        .await
        {
            Ok((mut items, truncated)) => {
                collection.items.append(&mut items);
                if truncated {
                    collection.warnings.push(format!(
                        "{}: Slack preview reached the 100-message safety cap.",
                        connection.workspace_name
                    ));
                }
            }
            Err(error) => collection.warnings.push(error),
        }
    }
    collection
        .items
        .sort_by(|left, right| left.occurred_at.cmp(&right.occurred_at));
    collection.items.dedup_by(|left, right| left.id == right.id);
    collection
}

fn requested_scopes(request: &SlackOAuthRequest) -> Vec<&'static str> {
    let mut scopes = vec!["search:read.public"];
    if request.include_private_channels {
        scopes.push("search:read.private");
    }
    if request.include_direct_messages {
        scopes.extend(["search:read.im", "search:read.mpim"]);
    }
    scopes
}

pub fn begin_oauth(request: SlackOAuthRequest) -> Result<SlackOAuthStart, String> {
    let client_id = client_id().ok_or_else(|| {
        "Slack OAuth is not configured in this build. Set MAESTRO_SLACK_CLIENT_ID when building Maestro."
            .to_string()
    })?;
    let state = Uuid::new_v4().simple().to_string();
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let created_at = Utc::now();
    let transaction = OAuthTransaction {
        verifier,
        redirect_uri: CALLBACK_URL.to_string(),
        created_at: created_at.to_rfc3339(),
    };
    store_json(OAUTH_TRANSACTION_SERVICE, &state, &transaction)?;

    let mut url = Url::parse(AUTHORIZE_URL).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", CALLBACK_URL)
        .append_pair("user_scope", &requested_scopes(&request).join(","))
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");

    Ok(SlackOAuthStart {
        authorization_url: url.into(),
        expires_at: (created_at + Duration::minutes(TRANSACTION_TTL_MINUTES)).to_rfc3339(),
    })
}

fn callback_value(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn friendly_oauth_error(code: &str) -> String {
    match code {
        "access_denied" => "Slack connection was cancelled.".to_string(),
        "app_not_admin_approved" | "not_allowed_token_type" => {
            "Your Slack administrator must approve Maestro before this workspace can be connected."
                .to_string()
        }
        "invalid_scope" => {
            "This Slack workspace did not accept one or more selected search permissions.".to_string()
        }
        "bad_redirect_uri" => {
            "Slack rejected Maestro's callback URL. The Slack app configuration needs to be updated."
                .to_string()
        }
        _ => format!("Slack could not complete the connection ({code})."),
    }
}

fn scopes_from(response: &OAuthResponse) -> Vec<String> {
    let raw = response
        .authed_user
        .as_ref()
        .and_then(|user| user.scope.as_deref())
        .or(response.scope.as_deref())
        .unwrap_or_default();
    let mut scopes = raw
        .split(',')
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

async fn exchange_callback(callback: &str) -> Result<SlackExchange, String> {
    let url =
        Url::parse(callback).map_err(|_| "Slack returned an invalid callback URL.".to_string())?;
    if !is_slack_callback_url(callback) {
        return Err("Rejected an unexpected OAuth callback URL.".to_string());
    }
    let state = callback_value(&url, "state")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Slack's callback did not include a state value.".to_string())?;
    let transaction: OAuthTransaction = load_json(OAUTH_TRANSACTION_SERVICE, &state)?;
    // A callback is one-shot even if Slack returns an error. Replaying the
    // same state must not permit another token exchange.
    delete_entry(OAUTH_TRANSACTION_SERVICE, &state)?;

    let created_at = chrono::DateTime::parse_from_rfc3339(&transaction.created_at)
        .map_err(|_| "The saved Slack sign-in request is invalid.".to_string())?
        .with_timezone(&Utc);
    if Utc::now() - created_at > Duration::minutes(TRANSACTION_TTL_MINUTES) {
        return Err("The Slack sign-in request expired. Start the connection again.".to_string());
    }
    if let Some(error) = callback_value(&url, "error") {
        return Err(friendly_oauth_error(&error));
    }
    let code = callback_value(&url, "code")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Slack's callback did not include an authorization code.".to_string())?;
    let client_id =
        client_id().ok_or_else(|| "Slack OAuth is unavailable in this build.".to_string())?;

    let response = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", transaction.redirect_uri.as_str()),
            ("code_verifier", transaction.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach Slack to finish connecting: {error}"))?
        .json::<OAuthResponse>()
        .await
        .map_err(|error| format!("Slack returned an unreadable OAuth response: {error}"))?;
    if !response.ok {
        return Err(friendly_oauth_error(
            response.error.as_deref().unwrap_or("unknown_error"),
        ));
    }

    let authed_user = response.authed_user.as_ref();
    let access_token = authed_user
        .and_then(|user| user.access_token.clone())
        .or_else(|| response.access_token.clone())
        .ok_or_else(|| "Slack connected but returned no user access token.".to_string())?;
    let refresh_token = authed_user
        .and_then(|user| user.refresh_token.clone())
        .or_else(|| response.refresh_token.clone());
    let expires_in = authed_user
        .and_then(|user| user.expires_in)
        .or(response.expires_in);

    let auth = reqwest::Client::new()
        .post(AUTH_TEST_URL)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|error| {
            format!("Slack connected, but the workspace identity check failed: {error}")
        })?
        .json::<AuthTestResponse>()
        .await
        .map_err(|error| format!("Slack returned an unreadable identity response: {error}"))?;
    if !auth.ok {
        return Err(friendly_oauth_error(
            auth.error.as_deref().unwrap_or("auth_test_failed"),
        ));
    }

    let workspace_id = auth
        .team_id
        .or_else(|| response.team.as_ref().and_then(|team| team.id.clone()))
        .ok_or_else(|| "Slack returned no workspace identifier.".to_string())?;
    let user_id = auth
        .user_id
        .or_else(|| authed_user.and_then(|user| user.id.clone()))
        .ok_or_else(|| "Slack returned no user identifier.".to_string())?;
    let workspace_name = auth
        .team
        .or_else(|| response.team.as_ref().and_then(|team| team.name.clone()))
        .unwrap_or_else(|| workspace_id.clone());
    let display_name = auth.user.unwrap_or_else(|| user_id.clone());
    let now = Utc::now().to_rfc3339();
    let credential = SlackCredential {
        access_token,
        refresh_token,
        expires_at: expires_in
            .map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339()),
    };
    let scopes = scopes_from(&response);
    Ok(SlackExchange {
        connection: SlackConnection {
            workspace_id,
            enterprise_id: response.enterprise.and_then(|enterprise| enterprise.id),
            user_id,
            workspace_name,
            display_name,
            granted_scopes: scopes,
            status: "connected".to_string(),
            connected_at: now.clone(),
            last_validated_at: Some(now),
        },
        credential,
    })
}

fn persist_exchange(conn: &Connection, exchange: SlackExchange) -> Result<SlackConnection, String> {
    let connection = exchange.connection;
    let workspace_id = connection.workspace_id.clone();
    let credential_ref = format!("slack:{workspace_id}");
    // Store the secret before publishing metadata. If the DB write fails,
    // remove it again so an invisible orphan credential is not left behind.
    store_json(CONNECTION_SERVICE, &workspace_id, &exchange.credential)?;
    let result = conn.execute(
        "INSERT INTO daybook_slack_connections (
            workspace_id, enterprise_id, user_id, workspace_name, display_name,
            granted_scopes_json, credential_ref, status, connected_at, last_validated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'connected', ?8, ?8)
         ON CONFLICT(workspace_id) DO UPDATE SET
            enterprise_id = excluded.enterprise_id,
            user_id = excluded.user_id,
            workspace_name = excluded.workspace_name,
            display_name = excluded.display_name,
            granted_scopes_json = excluded.granted_scopes_json,
            credential_ref = excluded.credential_ref,
            status = 'connected',
            connected_at = excluded.connected_at,
            last_validated_at = excluded.last_validated_at",
        params![
            connection.workspace_id,
            connection.enterprise_id,
            connection.user_id,
            connection.workspace_name,
            connection.display_name,
            serde_json::to_string(&connection.granted_scopes).map_err(|error| error.to_string())?,
            credential_ref,
            connection.connected_at,
        ],
    );
    if let Err(error) = result {
        let _ = delete_entry(CONNECTION_SERVICE, &workspace_id);
        return Err(error.to_string());
    }
    get_connection(conn, &workspace_id)?
        .ok_or_else(|| "Slack connection was not saved.".to_string())
}

pub async fn poll_oauth(state: &AppState) -> Result<SlackOAuthPoll, String> {
    let callback = state
        .pending_daybook_oauth_urls
        .lock()
        .map_err(|error| error.to_string())?
        .pop();
    let Some(callback) = callback else {
        return Ok(SlackOAuthPoll {
            status: SlackOAuthPollStatus::Waiting,
            connection: None,
            detail: "Waiting for Slack to return to Maestro.".to_string(),
        });
    };
    match exchange_callback(&callback).await {
        Ok(exchange) => {
            let connection = {
                let conn = state.db.lock().map_err(|error| error.to_string())?;
                persist_exchange(&conn, exchange)?
            };
            Ok(SlackOAuthPoll {
                status: SlackOAuthPollStatus::Connected,
                detail: format!("Connected {}.", connection.workspace_name),
                connection: Some(connection),
            })
        }
        Err(detail) => Ok(SlackOAuthPoll {
            status: SlackOAuthPollStatus::Failed,
            connection: None,
            detail,
        }),
    }
}

pub fn list_connections(conn: &Connection) -> Result<Vec<SlackConnection>, String> {
    let mut statement = conn
        .prepare(
            "SELECT workspace_id, enterprise_id, user_id, workspace_name, display_name,
                    granted_scopes_json, status, connected_at, last_validated_at
             FROM daybook_slack_connections ORDER BY workspace_name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let connections = statement
        .query_map([], |row| {
            let scopes_json = row.get::<_, String>(5)?;
            Ok(SlackConnection {
                workspace_id: row.get(0)?,
                enterprise_id: row.get(1)?,
                user_id: row.get(2)?,
                workspace_name: row.get(3)?,
                display_name: row.get(4)?,
                granted_scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
                status: row.get(6)?,
                connected_at: row.get(7)?,
                last_validated_at: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(connections)
}

fn get_connection(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Option<SlackConnection>, String> {
    Ok(list_connections(conn)?
        .into_iter()
        .find(|connection| connection.workspace_id == workspace_id))
}

pub async fn disconnect(state: &AppState, workspace_id: &str) -> Result<(), String> {
    if !workspace_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("Invalid Slack workspace identifier.".to_string());
    }
    if let Ok(credential) = load_json::<SlackCredential>(CONNECTION_SERVICE, workspace_id) {
        // Revocation is best effort. Local removal must still work if the
        // workspace is offline or the token has already been revoked.
        let _ = reqwest::Client::new()
            .post(REVOKE_URL)
            .bearer_auth(credential.access_token)
            .send()
            .await;
    }
    delete_entry(CONNECTION_SERVICE, workspace_id)?;
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM daybook_slack_connections WHERE workspace_id = ?1",
        params![workspace_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_slack_callback_route() {
        assert!(is_slack_callback_url(
            "maestro://oauth/slack?code=x&state=y"
        ));
        assert!(!is_slack_callback_url("maestro://oauth/jira?code=x"));
        assert!(!is_slack_callback_url("https://example.com/oauth/slack"));
    }

    #[test]
    fn expands_sensitive_scopes_only_when_selected() {
        assert_eq!(
            requested_scopes(&SlackOAuthRequest {
                include_private_channels: false,
                include_direct_messages: false,
            }),
            vec!["search:read.public"]
        );
        assert_eq!(
            requested_scopes(&SlackOAuthRequest {
                include_private_channels: true,
                include_direct_messages: true,
            }),
            vec![
                "search:read.public",
                "search:read.private",
                "search:read.im",
                "search:read.mpim"
            ]
        );
    }
}
