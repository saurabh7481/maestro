//! WebSocket streaming for the mobile relay. Read-only relays of events
//! Maestro already emits — writes (send a prompt, type into a terminal) go
//! through `routes.rs`'s POST endpoints instead, so these handlers never
//! need to parse anything the client sends, only notice when it disconnects.
//!
//! Taps the existing Tauri event bus from the Rust side
//! (`Listener::listen`/`unlisten`) rather than touching
//! `agents/manager.rs`/`terminal.rs` internals at all: those already emit
//! `agent://{run_id}/event` and `pty://{terminal_id}/data` for the desktop
//! webview to consume, and a Rust-side listener sees the exact same events.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Extension;
use axum::Router;
use tauri::{Listener, Manager};

use super::auth::DeviceAuth;
use super::server::RelayCtx;
use super::RelayState;

async fn agent_stream(
    ws: WebSocketUpgrade,
    State(ctx): State<RelayCtx>,
    Extension(auth): Extension<DeviceAuth>,
    Path(run_id): Path<String>,
) -> Response {
    let channel = crate::agents::manager::agent_event_channel(&run_id);
    ws.on_upgrade(move |socket| forward_channel(socket, ctx, auth, channel))
}

async fn terminal_stream(
    ws: WebSocketUpgrade,
    State(ctx): State<RelayCtx>,
    Extension(auth): Extension<DeviceAuth>,
    Path(terminal_id): Path<String>,
) -> Response {
    let channel = crate::terminal::pty_event_channel(&terminal_id);
    ws.on_upgrade(move |socket| forward_channel(socket, ctx, auth, channel))
}

/// Forwards every payload published on `channel` to `socket` until the
/// client disconnects, then tears down the Tauri listener — otherwise it
/// would keep firing into a channel nothing is draining, forever, for
/// every phone that ever opened this tab. Also marks the calling device
/// connected/disconnected around the same lifetime, for the desktop
/// Connected Devices pane's online dot (`devices.rs`).
async fn forward_channel(mut socket: WebSocket, ctx: RelayCtx, auth: DeviceAuth, channel: String) {
    let relay_state = ctx.app.state::<RelayState>();
    relay_state.mark_connected(&auth.device_id);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let listener_id = ctx.app.listen(channel, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    loop {
        tokio::select! {
            payload = rx.recv() => {
                match payload {
                    Some(payload) => {
                        if socket.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                if !matches!(incoming, Some(Ok(_))) {
                    break;
                }
            }
        }
    }

    ctx.app.unlisten(listener_id);
    relay_state.mark_disconnected(&auth.device_id);
}

pub(super) fn router(ctx: RelayCtx) -> Router {
    let read = axum::middleware::from_fn_with_state(ctx.clone(), super::auth::require_read);
    Router::new()
        .route(
            "/api/agents/{run_id}/stream",
            get(agent_stream).route_layer(read.clone()),
        )
        .route(
            "/api/terminals/{terminal_id}/stream",
            get(terminal_stream).route_layer(read),
        )
        .with_state(ctx)
}
