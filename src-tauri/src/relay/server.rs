//! Binds the relay's axum server and serves it until told to stop. Mirrors
//! `agents/mcp_tools.rs::spawn_mcp_server`'s bind/serve shape — the one
//! other place this codebase already stands up a loopback axum server —
//! plus graceful shutdown, since unlike the MCP server this one has an
//! explicit on/off toggle (the Settings "Enable Remote Access" switch).

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tower_http::services::{ServeDir, ServeFile};

/// Shared axum handler state — just the `AppHandle`, since every handler's
/// real state is `AppState`, reached via `ctx.app.state::<AppState>()`
/// exactly the way a `#[tauri::command]` reaches it via its `State`
/// extractor.
#[derive(Clone)]
pub(super) struct RelayCtx {
    pub app: AppHandle,
}

/// Fixed rather than ephemeral: Tailscale Funnel forwards its public port
/// to one specific local port, so the relay needs to bind the same port
/// every time rather than a fresh random one per run. Arbitrary pick in
/// the IANA dynamic/private range, just needs to stay stable across
/// releases so a previously-generated Funnel config keeps working.
const RELAY_PORT: u16 = 51823;

/// Where the mobile app's built static files (`mobile/dist`, a separate
/// Vite project — see `relay/mod.rs`'s module doc) live at runtime.
/// Production: bundled as a Tauri resource at `mobile/` under the
/// resource dir (`tauri.conf.json`'s `bundle.resources`). Dev/`cargo run`:
/// no resource dir exists, so this falls back to the path next to the
/// crate itself — `pnpm --filter mobile build` (or a Phase-4 dev-serve
/// step) is expected to have populated it. The production path is tried
/// first and only used if it actually has an `index.html`, so a dev build
/// run from an installed release build doesn't silently serve nothing.
fn mobile_dist_dir(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("mobile");
        if bundled.join("index.html").is_file() {
            return bundled;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../mobile/dist"))
}

/// Binds the relay's local port and starts serving in the background,
/// returning that port and a sender that stops the server when fired.
pub(super) async fn serve(app: AppHandle) -> Result<(u16, oneshot::Sender<()>), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", RELAY_PORT))
        .await
        .map_err(|e| {
            format!("failed to bind the mobile relay server to 127.0.0.1:{RELAY_PORT}: {e}")
        })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let dist = mobile_dist_dir(&app);
    let index = dist.join("index.html");
    // A plain-file fallback rather than a 404 for anything `ServeDir`
    // doesn't recognize as a real asset — the mobile app does its own
    // client-side routing (see `mobile/src/nav.ts`), so a refresh on
    // `/projects/x/worktrees` has to still get `index.html`, not a 404.
    let static_service = ServeDir::new(&dist).fallback(ServeFile::new(&index));

    let ctx = RelayCtx { app };
    let router = super::routes::router(ctx.clone())
        .merge(super::ws::router(ctx.clone()))
        .merge(super::pairing::router(ctx))
        .fallback_service(static_service);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(error) = result {
            log::error!("Mobile relay server stopped unexpectedly: {error}");
        }
    });

    log::info!("Mobile relay server listening on 127.0.0.1:{port}");
    Ok((port, shutdown_tx))
}
