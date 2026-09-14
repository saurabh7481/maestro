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
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Extension;
use axum::Router;
use tauri::{Listener, Manager};

use crate::state::AppState;

use super::auth::DeviceAuth;
use super::server::RelayCtx;
use super::RelayState;

/// `?since=<seq>`: the last event sequence this client already has. A
/// phone reconnecting after a WiFi/cellular handoff passes what it had and
/// gets exactly the events it missed — the difference between "resumes the
/// conversation" and "silently loses whatever streamed while it was
/// reconnecting". Absent (or 0) means "I have nothing, send the run's
/// whole history".
#[derive(serde::Deserialize)]
struct StreamQuery {
    #[serde(default)]
    since: u64,
}

async fn agent_stream(
    ws: WebSocketUpgrade,
    State(ctx): State<RelayCtx>,
    Extension(auth): Extension<DeviceAuth>,
    Path(run_id): Path<String>,
    Query(query): Query<StreamQuery>,
) -> Response {
    let channel = crate::agents::manager::agent_event_channel(&run_id);
    ws.on_upgrade(move |socket| forward_agent(socket, ctx, auth, channel, run_id, query.since))
}

/// Attaches to a run without a gap or a duplicate at the seam.
///
/// The order is the whole correctness argument: the live listener is
/// registered *before* the backlog is read, so an event firing during the
/// handover lands in the channel buffer rather than falling between the
/// two. The backlog is then sent, and the live stream drops anything at or
/// below the sequence the backlog already covered. Reading the backlog
/// first and subscribing after would lose exactly the events that arrive
/// in between — the window that is busiest precisely when a turn is
/// streaming.
async fn forward_agent(
    mut socket: WebSocket,
    ctx: RelayCtx,
    auth: DeviceAuth,
    channel: String,
    run_id: String,
    since: u64,
) {
    let relay_state = ctx.app.state::<RelayState>();
    relay_state.mark_connected(&auth.device_id);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let listener_id = ctx.app.listen(channel, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    let snapshot = crate::agents::run_log::snapshot(&ctx.app, &run_id, since);
    let backlog_through = snapshot.seq;
    let mut backlog_sent = send_json(
        &mut socket,
        &RelayFrame::Snapshot {
            snapshot: &snapshot,
        },
    )
    .await;
    if backlog_sent {
        for event in &snapshot.events {
            if !send_json(&mut socket, &RelayFrame::Event { event }).await {
                backlog_sent = false;
                break;
            }
        }
    }

    // Only go live if the client actually received the backlog; a socket
    // that died mid-handover has nothing to resume onto.
    if backlog_sent {
        loop {
            tokio::select! {
                payload = rx.recv() => {
                    match payload {
                        Some(payload) => {
                            // Already covered by the backlog just sent.
                            if sequence_of(&payload).is_some_and(|seq| seq <= backlog_through) {
                                continue;
                            }
                            if socket
                                .send(Message::Text(live_frame(&payload).into()))
                                .await
                                .is_err()
                            {
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
    }

    ctx.app.unlisten(listener_id);
    relay_state.mark_disconnected(&auth.device_id);
}

/// What the agent socket carries. Terminal streams still send raw payloads
/// (a PTY byte stream has no event identity to sequence), so this applies
/// to the agent stream only.
#[derive(serde::Serialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
enum RelayFrame<'a> {
    /// Always first: where the run is, and how far this backlog reaches.
    Snapshot {
        snapshot: &'a crate::agents::run_log::RunSnapshot,
    },
    Event {
        event: &'a crate::agents::run_log::SequencedEvent,
    },
}

/// Wraps an already-serialized `SequencedEvent` in the `event` frame
/// without re-parsing it — the payload is forwarded verbatim.
fn live_frame(payload: &str) -> String {
    format!("{{\"frame\":\"event\",\"event\":{payload}}}")
}

async fn send_json<T: serde::Serialize>(socket: &mut WebSocket, value: &T) -> bool {
    let Ok(text) = serde_json::to_string(value) else {
        return false;
    };
    socket.send(Message::Text(text.into())).await.is_ok()
}

/// Reads the `seq` out of a live payload without deserializing the whole
/// event — the only field this needs.
fn sequence_of(payload: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("seq")?
        .as_u64()
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

/// Pushes the whole session list whenever anything about it changes.
///
/// The last piece of polling in the mobile client, and the last place a
/// change could be missed entirely: a session that started and finished
/// between two 3-second polls was never seen at all, and a title landed up
/// to a poll late. Now the list is pushed on
/// `SESSIONS_CHANGED_CHANNEL` — created, retitled, status moved, disposed
/// — with the client's poll demoted to a slow reconcile.
///
/// Coalesced: a burst of changes (a turn finishing touches status, then
/// the run entry, then the title) collapses into one push, and the list is
/// rebuilt at send time so the push always carries current state rather
/// than a queue of stale ones.
async fn sessions_stream(
    ws: WebSocketUpgrade,
    State(ctx): State<RelayCtx>,
    Extension(auth): Extension<DeviceAuth>,
) -> Response {
    ws.on_upgrade(move |socket| forward_sessions(socket, ctx, auth))
}

/// How long to pool change notifications before rebuilding and sending.
/// Short enough to read as instant, long enough that the several
/// notifications one user action produces cost one push.
const SESSIONS_COALESCE: std::time::Duration = std::time::Duration::from_millis(80);

async fn forward_sessions(mut socket: WebSocket, ctx: RelayCtx, auth: DeviceAuth) {
    let relay_state = ctx.app.state::<RelayState>();
    relay_state.mark_connected(&auth.device_id);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let listener_id = ctx.app.listen(super::SESSIONS_CHANGED_CHANNEL, move |_| {
        let _ = tx.send(());
    });

    // Subscribe first, then send the current list: a change landing during
    // the handover queues a notification rather than being lost, so the
    // client's first push is never stale.
    let mut ok = send_sessions(&mut socket, &ctx).await;

    while ok {
        tokio::select! {
            notified = rx.recv() => {
                if notified.is_none() {
                    break;
                }
                // Drain whatever else piled up in the coalesce window;
                // they all describe the same "re-read the list" work.
                tokio::time::sleep(SESSIONS_COALESCE).await;
                while rx.try_recv().is_ok() {}
                ok = send_sessions(&mut socket, &ctx).await;
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

async fn send_sessions(socket: &mut WebSocket, ctx: &RelayCtx) -> bool {
    let Ok(sessions) = crate::processes::session_rows(&ctx.app.state::<AppState>()) else {
        return true;
    };
    send_json(socket, &SessionsFrame { sessions }).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsFrame {
    sessions: Vec<crate::processes::SessionRow>,
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
            get(terminal_stream).route_layer(read.clone()),
        )
        .route(
            "/api/sessions/stream",
            get(sessions_stream).route_layer(read),
        )
        .with_state(ctx)
}
