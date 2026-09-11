//! Bearer-token auth for every relay route except the pairing exchange
//! itself (`pairing.rs`, deliberately open — it's what issues the token).
//! REST calls send `Authorization: Bearer <token>`; WebSocket calls send a
//! `?token=` query param instead, since browsers can't set custom headers
//! on `new WebSocket()`. Both are accepted here so downstream handlers
//! never touch either transport's auth detail themselves.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::state::AppState;

use super::server::RelayCtx;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AccessLevel {
    Read,
    Write,
}

/// Inserted into the request's extensions by both middlewares below, so
/// any handler that cares which device is calling (currently just
/// `ws.rs`, for the Connected Devices online dot) can pull it out with a
/// plain `Extension<DeviceAuth>` extractor.
#[derive(Clone)]
pub(super) struct DeviceAuth {
    pub device_id: String,
    pub access: AccessLevel,
}

pub(super) fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn forbidden(message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn extract_token(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Some(token) = value.to_str().ok().and_then(|v| v.strip_prefix("Bearer ")) {
            return Some(token.to_string());
        }
    }
    let query = uri.query()?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
}

/// Looks a token up by its hash, rejects an unknown or revoked device, and
/// best-effort bumps `last_seen_at` — a failed update here (a poisoned
/// lock, a write race) shouldn't turn a valid request into a 401.
fn authenticate(app_state: &tauri::State<'_, AppState>, token: &str) -> Result<DeviceAuth, String> {
    let hash = hash_token(token);
    let conn = app_state.db.lock().map_err(|e| e.to_string())?;
    let row: (String, String, Option<String>) = conn
        .query_row(
            "SELECT id, access_level, revoked_at FROM paired_devices WHERE token_hash = ?1",
            rusqlite::params![hash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown device token".to_string())?;
    let (device_id, access_level, revoked_at) = row;
    if revoked_at.is_some() {
        return Err("this device's access has been revoked".to_string());
    }
    let access = match access_level.as_str() {
        "write" => AccessLevel::Write,
        _ => AccessLevel::Read,
    };
    let _ = conn.execute(
        "UPDATE paired_devices SET last_seen_at = ?1 WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), device_id],
    );
    Ok(DeviceAuth { device_id, access })
}

/// Returns the error message rather than a built `Response` — clippy flags
/// `Result<_, Response>` as a large error type, and every caller needs to
/// distinguish "no/invalid token" (401) from "valid but read-only" (403)
/// anyway, so a plain `String` is both smaller and more useful here.
fn authenticate_request(ctx: &RelayCtx, request: &Request) -> Result<DeviceAuth, String> {
    let token = extract_token(request.headers(), request.uri())
        .ok_or_else(|| "missing bearer token".to_string())?;
    let app_state = ctx.app.state::<AppState>();
    authenticate(&app_state, &token)
}

/// Gate for GET routes and the WS streams — any non-revoked paired device,
/// read-only or write.
pub(super) async fn require_read(
    State(ctx): State<RelayCtx>,
    mut request: Request,
    next: Next,
) -> Response {
    match authenticate_request(&ctx, &request) {
        Ok(auth) => {
            request.extensions_mut().insert(auth);
            next.run(request).await
        }
        Err(message) => unauthorized(&message),
    }
}

/// Gate for every mutating route (send a prompt, type into a terminal,
/// kill/interrupt, create a session) — read-only devices get a 403, not a
/// silent downgrade or a confusing 401.
pub(super) async fn require_write(
    State(ctx): State<RelayCtx>,
    mut request: Request,
    next: Next,
) -> Response {
    match authenticate_request(&ctx, &request) {
        Ok(auth) if auth.access == AccessLevel::Write => {
            request.extensions_mut().insert(auth);
            next.run(request).await
        }
        Ok(_) => forbidden("this device has read-only access"),
        Err(message) => unauthorized(&message),
    }
}
