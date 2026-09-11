//! HTTP handlers for the mobile relay. Every handler is a thin translation
//! layer: pull `AppState` off the shared `AppHandle`, call the exact same
//! function the matching Tauri command calls, serialize the result. No
//! business logic lives here — see `relay/mod.rs`'s module doc.

use crate::agents::adapter::PermissionMode;
use crate::agents::capabilities::{capabilities_for, AgentCapabilities};
use crate::agents::manager::{PermissionDecision, PermissionOutcome, StartAgentSessionRequest};
use crate::agents::transcripts::StoredTranscript;
use crate::agents::AgentKind;
use crate::commands::agents::ModelOption;
use crate::models::{Project, Worktree};
use crate::processes::ManagedProcess;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use tauri::Manager;

use super::auth::{AccessLevel, DeviceAuth};
use super::devices::PairedDevice;
use super::server::RelayCtx;
use super::RelayState;

pub(super) struct ApiError(String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": self.0 })),
        )
            .into_response()
    }
}

impl From<String> for ApiError {
    fn from(value: String) -> Self {
        ApiError(value)
    }
}

/// A worktree's checked-out path, looked up by id — the join point between
/// the frontend's `worktreeId` addressing and the two backends
/// (`agents::manager`, `terminal.rs`) that address by root path instead.
/// The `worktrees` table (`db.rs`) already exists for exactly this: a
/// stable id over `git worktree list`'s own reconciled paths.
fn worktree_root_path(
    state: &tauri::State<'_, AppState>,
    worktree_id: &str,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT path FROM worktrees WHERE id = ?1",
        rusqlite::params![worktree_id],
        |row| row.get(0),
    )
    .map_err(|_| format!("no such worktree '{worktree_id}'"))
}

async fn list_projects(State(ctx): State<RelayCtx>) -> Result<Json<Vec<Project>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let projects = crate::commands::projects::list_projects(state)
        .await
        .map_err(ApiError)?;
    Ok(Json(projects))
}

async fn list_worktrees(
    State(ctx): State<RelayCtx>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<Worktree>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let worktrees = crate::commands::worktrees::list_worktrees(state, project_id)
        .await
        .map_err(ApiError)?;
    Ok(Json(worktrees))
}

/// Agent + terminal sessions live in a worktree — editor/diff/etc. tabs are
/// desktop-chrome-only and out of scope (see the plan doc). Both kinds
/// populate `ManagedProcess.worktree_root` (`processes.rs`), so filtering
/// on the resolved root, rather than juggling per-kind id fields, covers
/// both uniformly.
async fn list_sessions(
    State(ctx): State<RelayCtx>,
    Path(worktree_id): Path<String>,
) -> Result<Json<Vec<ManagedProcess>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let root = worktree_root_path(&state, &worktree_id).map_err(ApiError)?;
    let snapshot = crate::processes::list_managed_processes(state)
        .await
        .map_err(ApiError)?;
    let sessions = snapshot
        .processes
        .into_iter()
        .filter(|p| {
            matches!(
                p.kind,
                crate::processes::ManagedProcessKind::Agent
                    | crate::processes::ManagedProcessKind::Terminal
            )
        })
        .filter(|p| p.worktree_root.as_deref() == Some(root.as_str()))
        .collect();
    Ok(Json(sessions))
}

/// Every agent/terminal session across every worktree, not just one —
/// what the mobile app's tab dock polls so a session started on the
/// desktop (or on another device) shows up there without the user having
/// to go find and open it themselves first.
async fn list_all_sessions(
    State(ctx): State<RelayCtx>,
) -> Result<Json<Vec<ManagedProcess>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let snapshot = crate::processes::list_managed_processes(state)
        .await
        .map_err(ApiError)?;
    let sessions = snapshot
        .processes
        .into_iter()
        .filter(|p| {
            matches!(
                p.kind,
                crate::processes::ManagedProcessKind::Agent
                    | crate::processes::ManagedProcessKind::Terminal
            )
        })
        .collect();
    Ok(Json(sessions))
}

/// Backs the mobile composer's "Add context" file picker — the same
/// gitignore-respecting `git ls-files` enumeration the desktop's own
/// @-mention search uses (`AgentComposer.tsx::useWorktreeFileList`).
async fn worktree_files(
    State(ctx): State<RelayCtx>,
    Path(worktree_id): Path<String>,
) -> Result<Json<Vec<String>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let root = worktree_root_path(&state, &worktree_id).map_err(ApiError)?;
    let files = crate::search::list_files(std::path::Path::new(&root))
        .await
        .map_err(ApiError)?;
    Ok(Json(files))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentSessionBody {
    kind: AgentKind,
    first_message: String,
    model: Option<String>,
    effort: Option<String>,
    #[serde(default)]
    fast: bool,
    permission_mode: Option<PermissionMode>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedAgentSession {
    run_id: String,
}

async fn create_agent_session(
    State(ctx): State<RelayCtx>,
    Path(worktree_id): Path<String>,
    Json(body): Json<CreateAgentSessionBody>,
) -> Result<Json<CreatedAgentSession>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let worktree_root = worktree_root_path(&state, &worktree_id).map_err(ApiError)?;
    let run_id = uuid::Uuid::new_v4().to_string();
    crate::agents::manager::start_agent_session(
        ctx.app.clone(),
        state,
        StartAgentSessionRequest {
            run_id: run_id.clone(),
            worktree_id,
            worktree_root,
            kind: body.kind,
            resume_session_id: None,
            fork_session: false,
            first_message: body.first_message,
            model: body.model,
            effort: body.effort,
            fast: body.fast,
            // Explicit safe default (not `PermissionMode::default()`,
            // which is `Auto` — see its doc comment) so a mobile-created
            // session starts gated exactly like a fresh desktop tab does.
            permission_mode: body.permission_mode.unwrap_or(PermissionMode::Manual),
        },
    )
    .await
    .map_err(ApiError)?;
    Ok(Json(CreatedAgentSession { run_id }))
}

/// Hydrates a mobile session's history on cold-open — the same durable,
/// rendering-ready snapshot (`agents/transcripts.rs`) the desktop restores
/// a tab from after a restart. Without this, a session opened on mobile
/// that wasn't live-streamed to it from the start would show blank.
/// `Option` rather than 404: "no transcript saved yet" is a normal state
/// for a session mobile is opening for the first time, not an error.
async fn get_agent_transcript(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
) -> Result<Json<Option<StoredTranscript>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let transcript = crate::agents::transcripts::load_agent_transcript(state, run_id)
        .await
        .map_err(ApiError)?;
    Ok(Json(transcript))
}

/// The composer's model/effort/fast picker row (mirrors the desktop's
/// `AgentComposer.tsx`) needs to know what a kind offers before it can
/// offer anything itself — no fake dropdowns (docs/V1_SCOPE.md §6).
async fn agent_models(
    State(ctx): State<RelayCtx>,
    Path(kind): Path<AgentKind>,
) -> Result<Json<Vec<ModelOption>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let models = crate::commands::agents::list_agent_models(state, kind)
        .await
        .map_err(ApiError)?;
    Ok(Json(models))
}

/// `capabilities_for` is a pure function (no CLI probing) — unlike
/// `agent_models` above, no `AppState` needed.
async fn agent_capabilities(Path(kind): Path<AgentKind>) -> Json<AgentCapabilities> {
    Json(capabilities_for(kind))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetConfigurationBody {
    model: Option<String>,
    effort: Option<String>,
    #[serde(default)]
    fast: bool,
}

async fn set_agent_configuration(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
    Json(body): Json<SetConfigurationBody>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::agents::manager::set_agent_configuration(
        state,
        run_id,
        body.model,
        body.effort,
        body.fast,
    )
    .await
    .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a run is *actually* configured as right now — polled by the
/// mobile composer on open (and periodically while visible) so it shows
/// the same model/effort/permission-mode the desktop last set, rather
/// than always starting from its own defaults. A distinct path from the
/// `POST .../configuration` route above rather than the same path under a
/// different verb — axum's per-route `route_layer` wraps a whole
/// `MethodRouter`, not one method within it, and this GET is read-gated
/// while that POST is write-gated.
async fn get_agent_configuration(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
) -> Result<Json<Option<crate::agents::manager::AgentConfiguration>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let configuration = crate::agents::manager::get_agent_configuration(state, run_id)
        .await
        .map_err(ApiError)?;
    Ok(Json(configuration))
}

#[derive(serde::Deserialize)]
struct SetPermissionModeBody {
    mode: PermissionMode,
}

async fn set_permission_mode(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
    Json(body): Json<SetPermissionModeBody>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::agents::manager::set_permission_mode(state, run_id, body.mode)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
struct SendMessageBody {
    text: String,
}

async fn send_agent_message(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
    Json(body): Json<SendMessageBody>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::agents::manager::send_agent_message(ctx.app.clone(), state, run_id, body.text)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn respond_to_permission(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
    Json(decision): Json<PermissionDecision>,
) -> Result<Json<PermissionOutcome>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let outcome =
        crate::agents::manager::respond_to_permission(ctx.app.clone(), state, run_id, decision)
            .await
            .map_err(ApiError)?;
    Ok(Json(outcome))
}

async fn interrupt_agent(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::agents::manager::interrupt_agent(state, run_id)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_agent(
    State(ctx): State<RelayCtx>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::agents::manager::kill_agent(state, run_id)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
struct WriteTerminalBody {
    data: String,
}

async fn write_terminal(
    State(ctx): State<RelayCtx>,
    Path(terminal_id): Path<String>,
    Json(body): Json<WriteTerminalBody>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::terminal::write_terminal(state, terminal_id, body.data)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
struct ResizeTerminalBody {
    rows: u16,
    cols: u16,
}

async fn resize_terminal(
    State(ctx): State<RelayCtx>,
    Path(terminal_id): Path<String>,
    Json(body): Json<ResizeTerminalBody>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::terminal::resize_terminal(state, terminal_id, body.rows, body.cols)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_terminal(
    State(ctx): State<RelayCtx>,
    Path(terminal_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    crate::terminal::kill_terminal(state, terminal_id)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
struct ScrollbackResponse {
    text: String,
}

/// Backscroll for a terminal opened cold — otherwise the WS stream only
/// carries output produced *after* the phone connects, and a long-running
/// dev-server terminal would look empty until something new printed.
async fn terminal_scrollback(
    State(ctx): State<RelayCtx>,
    Path(terminal_id): Path<String>,
) -> Result<Json<ScrollbackResponse>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let terminals = state
        .terminals
        .lock()
        .map_err(|e| ApiError(e.to_string()))?;
    let text = terminals
        .get(&terminal_id)
        .map(|handle| handle.tail(crate::terminal::SCROLLBACK_CAP_BYTES))
        .unwrap_or_default();
    Ok(Json(ScrollbackResponse { text }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WhoAmI {
    device_id: String,
    access_level: &'static str,
}

/// Lets the mobile client learn its own access level up front (on connect,
/// and again after every reconnect) rather than discovering "read-only"
/// only when a write action 403s — the plan's read-only banner needs to
/// show immediately, not after a failed first attempt.
async fn whoami(Extension(auth): Extension<DeviceAuth>) -> Json<WhoAmI> {
    Json(WhoAmI {
        device_id: auth.device_id,
        access_level: match auth.access {
            AccessLevel::Write => "write",
            AccessLevel::Read => "read",
        },
    })
}

/// Mobile's self-service mirror of the desktop "Connected Devices" pane
/// (see `relay/devices.rs`'s doc comment) — same underlying functions, a
/// second front door onto them rather than a reimplementation. Deliberately
/// thinner than the desktop pane: listing and revoking cover "who's
/// connected, kick one out" from a phone; renaming and access-level changes
/// stay desktop-only, which is an acceptable v1 gap rather than a real
/// requirement gap.
async fn list_devices(State(ctx): State<RelayCtx>) -> Result<Json<Vec<PairedDevice>>, ApiError> {
    let state = ctx.app.state::<AppState>();
    let relay = ctx.app.state::<RelayState>();
    let devices = super::devices::list_paired_devices(state, relay)
        .await
        .map_err(ApiError)?;
    Ok(Json(devices))
}

async fn revoke_device(
    State(ctx): State<RelayCtx>,
    Path(device_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let state = ctx.app.state::<AppState>();
    super::devices::revoke_device(state, device_id)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) fn router(ctx: RelayCtx) -> Router {
    let read = axum::middleware::from_fn_with_state(ctx.clone(), super::auth::require_read);
    let write = axum::middleware::from_fn_with_state(ctx.clone(), super::auth::require_write);
    Router::new()
        .route("/api/me", get(whoami).route_layer(read.clone()))
        .route("/api/devices", get(list_devices).route_layer(read.clone()))
        .route(
            "/api/devices/{device_id}/revoke",
            post(revoke_device).route_layer(write.clone()),
        )
        .route(
            "/api/projects",
            get(list_projects).route_layer(read.clone()),
        )
        .route(
            "/api/projects/{project_id}/worktrees",
            get(list_worktrees).route_layer(read.clone()),
        )
        .route(
            "/api/worktrees/{worktree_id}/sessions",
            get(list_sessions).route_layer(read.clone()),
        )
        .route(
            "/api/sessions",
            get(list_all_sessions).route_layer(read.clone()),
        )
        .route(
            "/api/worktrees/{worktree_id}/files",
            get(worktree_files).route_layer(read.clone()),
        )
        .route(
            "/api/worktrees/{worktree_id}/agents",
            post(create_agent_session).route_layer(write.clone()),
        )
        .route(
            "/api/agent-models/{kind}",
            get(agent_models).route_layer(read.clone()),
        )
        .route(
            "/api/agent-capabilities/{kind}",
            get(agent_capabilities).route_layer(read.clone()),
        )
        .route(
            "/api/agents/{run_id}/transcript",
            get(get_agent_transcript).route_layer(read.clone()),
        )
        .route(
            "/api/agents/{run_id}/message",
            post(send_agent_message).route_layer(write.clone()),
        )
        .route(
            "/api/agents/{run_id}/configuration",
            post(set_agent_configuration).route_layer(write.clone()),
        )
        .route(
            "/api/agents/{run_id}/config",
            get(get_agent_configuration).route_layer(read.clone()),
        )
        .route(
            "/api/agents/{run_id}/permission-mode",
            post(set_permission_mode).route_layer(write.clone()),
        )
        .route(
            "/api/agents/{run_id}/permission",
            post(respond_to_permission).route_layer(write.clone()),
        )
        .route(
            "/api/agents/{run_id}/interrupt",
            post(interrupt_agent).route_layer(write.clone()),
        )
        .route(
            "/api/agents/{run_id}/kill",
            post(kill_agent).route_layer(write.clone()),
        )
        .route(
            "/api/terminals/{terminal_id}/scrollback",
            get(terminal_scrollback).route_layer(read.clone()),
        )
        .route(
            "/api/terminals/{terminal_id}/write",
            post(write_terminal).route_layer(write.clone()),
        )
        .route(
            "/api/terminals/{terminal_id}/resize",
            post(resize_terminal).route_layer(write.clone()),
        )
        .route(
            "/api/terminals/{terminal_id}/kill",
            post(kill_terminal).route_layer(write),
        )
        .with_state(ctx)
}
