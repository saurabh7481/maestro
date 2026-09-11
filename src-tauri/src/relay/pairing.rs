//! One-time pairing codes → long-lived device tokens. The desktop mints a
//! code (`create_pairing_code`, called from the "Connected Devices"
//! Settings pane's "Add Device" button) and shows it as a QR; a phone that
//! scans it calls `POST /api/pair/exchange` — the one relay route that is
//! deliberately unauthenticated, since requiring a token to get a token is
//! circular. A short TTL plus single-use consumption is what keeps that
//! safe: the exchange window is minutes, not indefinite.

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::state::AppState;

use super::auth::hash_token;
use super::routes::ApiError;
use super::server::RelayCtx;
use super::RelayState;

const PAIRING_CODE_TTL: Duration = Duration::from_secs(5 * 60);

/// Drops any code older than the TTL. Called inline wherever the pending
/// map is already locked, rather than as a separate timer task — the map
/// is tiny and touched rarely enough that a sweep-on-access is simpler
/// than another background loop to manage the lifetime of.
fn sweep_expired(pending: &mut std::collections::HashMap<String, Instant>) {
    let now = Instant::now();
    pending.retain(|_, issued_at| now.duration_since(*issued_at) < PAIRING_CODE_TTL);
}

#[tauri::command]
pub async fn create_pairing_code(state: tauri::State<'_, RelayState>) -> Result<String, String> {
    let code = uuid::Uuid::new_v4().simple().to_string();
    let mut pending = state
        .pending_pairing_codes
        .lock()
        .map_err(|e| e.to_string())?;
    sweep_expired(&mut pending);
    pending.insert(code.clone(), Instant::now());
    Ok(code)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeBody {
    code: String,
    device_name: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeResponse {
    device_id: String,
    token: String,
}

async fn exchange(
    State(ctx): State<RelayCtx>,
    Json(body): Json<ExchangeBody>,
) -> Result<Json<ExchangeResponse>, ApiError> {
    let relay_state = ctx.app.state::<RelayState>();
    {
        let mut pending = relay_state
            .pending_pairing_codes
            .lock()
            .map_err(|e| ApiError::from(e.to_string()))?;
        sweep_expired(&mut pending);
        if pending.remove(&body.code).is_none() {
            return Err(ApiError::from(
                "invalid or expired pairing code".to_string(),
            ));
        }
    }

    let device_id = uuid::Uuid::new_v4().to_string();
    // 256 bits from two v4 UUIDs' randomness, hex-joined — plenty for a
    // bearer token, and needs no dependency beyond `uuid`, already in use
    // everywhere else in this codebase for ids.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let token_hash = hash_token(&token);
    let name = body
        .device_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "New device".to_string());

    let app_state = ctx.app.state::<AppState>();
    {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| ApiError::from(e.to_string()))?;
        conn.execute(
            "INSERT INTO paired_devices (id, name, token_hash, access_level, created_at)
             VALUES (?1, ?2, ?3, 'write', ?4)",
            rusqlite::params![device_id, name, token_hash, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| ApiError::from(e.to_string()))?;
    }

    Ok(Json(ExchangeResponse { device_id, token }))
}

pub(super) fn router(ctx: RelayCtx) -> Router {
    Router::new()
        .route("/api/pair/exchange", post(exchange))
        .with_state(ctx)
}
