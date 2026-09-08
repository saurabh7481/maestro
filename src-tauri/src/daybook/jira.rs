//! Read-only Jira Cloud activity collection for Daybook.
//!
//! Credentials are supplied by the Maestro process environment and are
//! never persisted. The collector asks Jira for issues touched during the
//! day, then keeps only comments, worklogs, and changelog entries authored
//! by the authenticated account inside the exact local calendar window.

use chrono::{DateTime, NaiveDate, Utc};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const MAX_ISSUES: usize = 100;
const KEYCHAIN_SERVICE: &str = "maestro.daybook.jira";
const KEYCHAIN_ACCOUNT: &str = "connection";

#[derive(Debug, Clone)]
pub struct JiraActivity {
    pub id: String,
    pub occurred_at: String,
    pub label: String,
    pub context: String,
}

#[derive(Debug, Default)]
pub struct JiraCollection {
    pub items: Vec<JiraActivity>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct JiraCredentials {
    email: String,
    token: String,
    base_url: Url,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraUser {
    account_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    jql: String,
    fields: Vec<&'static str>,
    expand: String,
    max_results: usize,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    #[serde(default)]
    issues: Vec<JiraIssue>,
    #[serde(default)]
    is_last: Option<bool>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraIssue {
    key: String,
    #[serde(default)]
    fields: Value,
    #[serde(default)]
    changelog: Value,
}

fn credentials() -> Result<JiraCredentials, String> {
    environment_credentials().or_else(|environment_error| {
        load_stored_credentials().map_err(|stored_error| {
            if stored_error.contains("not connected") {
                environment_error
            } else {
                stored_error
            }
        })
    })
}

fn environment_credentials() -> Result<JiraCredentials, String> {
    let read = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Missing {name}."))
    };
    let email = read("JIRA_EMAIL")?;
    let token = read("JIRA_API_TOKEN")?;
    let raw_base = read("JIRA_BASE_URL")?;
    let mut base_url =
        Url::parse(&raw_base).map_err(|_| "JIRA_BASE_URL is not a valid URL.".to_string())?;
    if !matches!(base_url.scheme(), "https" | "http") {
        return Err(
            "JIRA_BASE_URL must use https (or http for a local development server).".to_string(),
        );
    }
    base_url.set_query(None);
    base_url.set_fragment(None);
    if !base_url.path().ends_with('/') {
        let path = format!("{}/", base_url.path().trim_end_matches('/'));
        base_url.set_path(&path);
    }
    Ok(JiraCredentials {
        email,
        token,
        base_url,
    })
}

fn jira_keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("The OS keychain is unavailable: {error}"))
}

fn load_stored_credentials() -> Result<JiraCredentials, String> {
    let encoded = jira_keychain_entry()?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => "Jira is not connected for scheduled runs.".to_string(),
            other => format!("The OS keychain could not read Jira credentials: {other}"),
        })?;
    serde_json::from_str(&encoded)
        .map_err(|error| format!("Stored Jira credentials are invalid: {error}"))
}

pub fn stored_credentials_available() -> bool {
    load_stored_credentials().is_ok()
}

pub fn import_environment_credentials() -> Result<(), String> {
    let credentials = environment_credentials()?;
    let encoded = serde_json::to_string(&credentials).map_err(|error| error.to_string())?;
    jira_keychain_entry()?
        .set_password(&encoded)
        .map_err(|error| format!("The OS keychain could not store Jira credentials: {error}"))
}

pub fn forget_credentials() -> Result<(), String> {
    match jira_keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "The OS keychain could not remove Jira credentials: {error}"
        )),
    }
}

fn endpoint(credentials: &JiraCredentials, path: &str) -> Result<Url, String> {
    credentials
        .base_url
        .join(path.trim_start_matches('/'))
        .map_err(|error| error.to_string())
}

async fn jira_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
    operation: &str,
) -> Result<T, String> {
    let response = request
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not reach Jira while {operation}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = match status.as_u16() {
            401 => "Jira rejected JIRA_EMAIL or JIRA_API_TOKEN.".to_string(),
            403 => "Jira credentials do not have permission to read this activity.".to_string(),
            404 => "JIRA_BASE_URL does not expose the Jira Cloud REST API.".to_string(),
            429 => "Jira rate limited the preview; try again shortly.".to_string(),
            _ => format!("Jira returned HTTP {status} while {operation}."),
        };
        return Err(detail);
    }
    response
        .json::<T>()
        .await
        .map_err(|error| format!("Jira returned unreadable data while {operation}: {error}"))
}

fn jira_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn in_window(value: &str, start: DateTime<Utc>, end: DateTime<Utc>) -> Option<String> {
    let timestamp = jira_timestamp(value)?;
    (timestamp >= start && timestamp < end).then(|| timestamp.to_rfc3339())
}

fn account_id(value: &Value) -> Option<&str> {
    value.get("accountId").and_then(Value::as_str)
}

fn adf_text(value: &Value) -> String {
    fn visit(value: &Value, output: &mut String) {
        if let Some(text) = value.get("text").and_then(Value::as_str) {
            if output
                .chars()
                .last()
                .is_some_and(|character| !character.is_whitespace())
            {
                output.push(' ');
            }
            output.push_str(text);
        }
        if let Some(children) = value.get("content").and_then(Value::as_array) {
            for child in children {
                visit(child, output);
            }
        }
    }
    if let Some(text) = value.as_str() {
        return text.trim().to_string();
    }
    let mut output = String::new();
    visit(value, &mut output);
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn shorten(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut shortened = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    shortened.push('…');
    shortened
}

fn collect_issue(
    issue: JiraIssue,
    account: &str,
    base_url: &Url,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    collection: &mut JiraCollection,
) {
    let summary = issue
        .fields
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("Untitled issue");
    let issue_context = format!(
        "{} · {} · {}browse/{}",
        issue.key,
        summary,
        base_url.as_str(),
        issue.key
    );

    if let Some(container) = issue.fields.get("comment") {
        let comments = container
            .get("comments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let total = container
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or(comments.len() as u64);
        if total > comments.len() as u64 {
            collection.warnings.push(format!(
                "{}: Jira returned only {} of {} comments in the search page.",
                issue.key,
                comments.len(),
                total
            ));
        }
        for comment in comments {
            if comment.get("author").and_then(account_id) != Some(account) {
                continue;
            }
            let Some(occurred_at) = comment
                .get("created")
                .and_then(Value::as_str)
                .and_then(|value| in_window(value, start, end))
            else {
                continue;
            };
            let text = shorten(adf_text(comment.get("body").unwrap_or(&Value::Null)), 500);
            collection.items.push(JiraActivity {
                id: format!(
                    "comment:{}:{}",
                    issue.key,
                    comment
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(&occurred_at)
                ),
                occurred_at,
                label: if text.is_empty() {
                    "Added a comment".to_string()
                } else {
                    format!("Commented: {text}")
                },
                context: issue_context.clone(),
            });
        }
    }

    if let Some(container) = issue.fields.get("worklog") {
        let worklogs = container
            .get("worklogs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let total = container
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or(worklogs.len() as u64);
        if total > worklogs.len() as u64 {
            collection.warnings.push(format!(
                "{}: Jira returned only {} of {} worklogs in the search page.",
                issue.key,
                worklogs.len(),
                total
            ));
        }
        for worklog in worklogs {
            if worklog.get("author").and_then(account_id) != Some(account) {
                continue;
            }
            let Some(occurred_at) = worklog
                .get("started")
                .and_then(Value::as_str)
                .and_then(|value| in_window(value, start, end))
            else {
                continue;
            };
            let time = worklog
                .get("timeSpent")
                .and_then(Value::as_str)
                .unwrap_or("time");
            let note = adf_text(worklog.get("comment").unwrap_or(&Value::Null));
            collection.items.push(JiraActivity {
                id: format!(
                    "worklog:{}:{}",
                    issue.key,
                    worklog
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(&occurred_at)
                ),
                occurred_at,
                label: if note.is_empty() {
                    format!("Logged {time}")
                } else {
                    format!("Logged {time}: {}", shorten(note, 420))
                },
                context: issue_context.clone(),
            });
        }
    }

    let histories = issue
        .changelog
        .get("histories")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let history_total = issue
        .changelog
        .get("total")
        .and_then(Value::as_u64)
        .unwrap_or(histories.len() as u64);
    if history_total > histories.len() as u64 {
        collection.warnings.push(format!(
            "{}: Jira changelog coverage is partial ({} of {}).",
            issue.key,
            histories.len(),
            history_total
        ));
    }
    for history in histories {
        if history.get("author").and_then(account_id) != Some(account) {
            continue;
        }
        let Some(occurred_at) = history
            .get("created")
            .and_then(Value::as_str)
            .and_then(|value| in_window(value, start, end))
        else {
            continue;
        };
        for (index, change) in history
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let field = change
                .get("field")
                .and_then(Value::as_str)
                .unwrap_or("issue");
            let from = change
                .get("fromString")
                .and_then(Value::as_str)
                .unwrap_or("empty");
            let to = change
                .get("toString")
                .and_then(Value::as_str)
                .unwrap_or("empty");
            collection.items.push(JiraActivity {
                id: format!(
                    "change:{}:{}:{}",
                    issue.key,
                    history
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(&occurred_at),
                    index
                ),
                occurred_at: occurred_at.clone(),
                label: shorten(format!("Changed {field}: {from} → {to}"), 500),
                context: issue_context.clone(),
            });
        }
    }
}

pub async fn collect_for_window(
    date: NaiveDate,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> JiraCollection {
    let mut collection = JiraCollection::default();
    let credentials = match credentials() {
        Ok(value) => value,
        Err(error) => {
            collection.warnings.push(error);
            return collection;
        }
    };
    let client = Client::new();
    let myself_url = match endpoint(&credentials, "rest/api/3/myself") {
        Ok(value) => value,
        Err(error) => {
            collection.warnings.push(error);
            return collection;
        }
    };
    let myself = match jira_json::<JiraUser>(
        client
            .get(myself_url)
            .basic_auth(&credentials.email, Some(&credentials.token)),
        "identifying the current user",
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            collection.warnings.push(error);
            return collection;
        }
    };
    let next = match date.succ_opt() {
        Some(value) => value,
        None => {
            collection
                .warnings
                .push("Jira collection date is outside the supported range.".to_string());
            return collection;
        }
    };
    let request = SearchRequest {
        jql: format!(
            "(updated >= \"{} 00:00\" AND updated < \"{} 00:00\") OR (worklogAuthor = currentUser() AND worklogDate = \"{}\") ORDER BY updated ASC",
            date.format("%Y-%m-%d"),
            next.format("%Y-%m-%d"),
            date.format("%Y-%m-%d")
        ),
        fields: vec!["summary", "comment", "worklog"],
        expand: "changelog".to_string(),
        max_results: MAX_ISSUES,
    };
    let search_url = match endpoint(&credentials, "rest/api/3/search/jql") {
        Ok(value) => value,
        Err(error) => {
            collection.warnings.push(error);
            return collection;
        }
    };
    let response = match jira_json::<SearchResponse>(
        client
            .post(search_url)
            .basic_auth(&credentials.email, Some(&credentials.token))
            .json(&request),
        "searching daily activity",
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            collection.warnings.push(error);
            return collection;
        }
    };
    if response.is_last == Some(false) || response.next_page_token.is_some() {
        collection.warnings.push(format!(
            "Jira preview reached the {MAX_ISSUES}-issue safety cap."
        ));
    }
    for issue in response.issues {
        collect_issue(
            issue,
            &myself.account_id,
            &credentials.base_url,
            start,
            end,
            &mut collection,
        );
    }
    collection
        .items
        .sort_by(|left, right| left.occurred_at.cmp(&right.occurred_at));
    let mut seen = HashSet::new();
    collection.items.retain(|item| seen.insert(item.id.clone()));
    collection
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plain_text_from_atlassian_document_format() {
        let value = serde_json::json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{"type": "text", "text": "Shipped"}, {"type": "text", "text": "today"}]
            }]
        });
        assert_eq!(adf_text(&value), "Shipped today");
    }
}
