//! Mobile control relay (see
//! `/home/saurabh/.claude/plans/enumerated-finding-biscuit.md`). A second,
//! additive front door onto the exact same `AppState` the desktop UI's own
//! Tauri commands drive — `routes.rs`/`ws.rs` call straight into
//! `agents::manager`, `terminal.rs` and `processes::list_managed_processes`
//! rather than reimplementing any of it, so a prompt sent from a phone and
//! one sent from the desktop app land on the identical run/terminal state.
//!
//! Bound to `127.0.0.1` only — reaching it from outside the machine is
//! Tailscale Funnel's job (a later phase), not this module's. Every route
//! except the pairing exchange itself requires a paired device's bearer
//! token (`auth.rs`); pairing (`pairing.rs`) is how a device gets one.

mod auth;
pub mod devices;
mod funnel;
pub mod pairing;
mod routes;
mod server;
mod ws;

use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;
use tauri::Manager;
use tokio::sync::oneshot;

use crate::state::AppState;

const RELAY_ENABLED_SETTING_KEY: &str = "relay.enabled";

/// Whether remote access was last left on — checked on app startup
/// (`lib.rs`'s `.setup()`) to restore it automatically, so a device
/// paired once stays paired across desktop restarts instead of the user
/// having to flip the Settings toggle back on every time. Defaults to
/// `false`, same as `RelayState::default()`'s own starting point, for a
/// fresh install that has never touched the toggle at all.
pub fn read_persisted_enabled(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT value_json FROM settings WHERE key = ?1",
        rusqlite::params![RELAY_ENABLED_SETTING_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|json| serde_json::from_str::<bool>(&json).ok())
    .unwrap_or(false)
}

fn write_persisted_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let conn = app_state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        rusqlite::params![
            RELAY_ENABLED_SETTING_KEY,
            serde_json::to_string(&enabled).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One running relay server's shutdown handle. Dropping/firing
/// `shutdown_tx` stops `axum::serve` via its graceful-shutdown future (see
/// `server.rs::serve`).
struct RunningRelay {
    port: u16,
    shutdown_tx: oneshot::Sender<()>,
    /// `None` when Funnel enable failed to report one even though the
    /// relay itself is up — shouldn't happen since `set_relay_enabled`
    /// rolls the whole thing back on a Funnel error, but kept optional
    /// rather than assumed.
    hostname: Option<String>,
}

/// Managed as its own Tauri state (`app.manage(RelayState::default())`)
/// rather than a field on `AppState` — keeps this additive feature from
/// touching the one struct every other subsystem also has a lock on.
#[derive(Default)]
pub struct RelayState {
    running: Mutex<Option<RunningRelay>>,
    /// Codes minted by `create_pairing_code`, not yet exchanged. Purely
    /// in-memory and short-lived by design (`pairing::PAIRING_CODE_TTL`) —
    /// a pairing code outliving an app restart would be a bug, not a
    /// missing feature, so this needs no persistence.
    pending_pairing_codes: Mutex<HashMap<String, Instant>>,
    /// Device ids with a currently-open WebSocket stream, for the desktop
    /// Connected Devices pane's online/offline dot. Populated/cleared by
    /// `ws.rs::forward_channel` around each connection's lifetime — best-
    /// effort presence, not a durable record (see `devices::PairedDevice`).
    connected_devices: Mutex<HashSet<String>>,
}

impl RelayState {
    fn mark_connected(&self, device_id: &str) {
        if let Ok(mut set) = self.connected_devices.lock() {
            set.insert(device_id.to_string());
        }
    }

    fn mark_disconnected(&self, device_id: &str) {
        if let Ok(mut set) = self.connected_devices.lock() {
            set.remove(device_id);
        }
    }

    fn is_connected(&self, device_id: &str) -> bool {
        self.connected_devices
            .lock()
            .map(|set| set.contains(device_id))
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub enabled: bool,
    pub port: Option<u16>,
    /// The Funnel-public hostname the relay is reachable on, e.g.
    /// `"my-laptop.tailxxxx.ts.net"`. `Some` exactly when `enabled` is
    /// true, since enabling the relay and enabling Funnel are one action.
    pub hostname: Option<String>,
}

/// Starts or stops the relay's local HTTP/WS server *and* Tailscale
/// Funnel together — Funnel-only means there's no LAN-direct mode to fall
/// back to, so a relay that's "on" but not publicly reachable (or vice
/// versa) would just be a confusing half-state. Idempotent in both
/// directions — enabling an already-running relay or disabling an already-
/// stopped one is a no-op, not an error, so the Settings toggle never needs
/// to track server state itself.
#[tauri::command]
pub async fn set_relay_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, RelayState>,
    enabled: bool,
) -> Result<RelayStatus, String> {
    if enabled {
        let already_running = state.running.lock().map_err(|e| e.to_string())?.is_some();
        if already_running {
            return relay_status(state).await;
        }
        let (port, shutdown_tx) = server::serve(app.clone()).await?;
        let hostname = match funnel::enable(port).await {
            Ok(hostname) => Some(hostname),
            Err(err) => {
                // Roll back: don't leave a relay server running that
                // Funnel failed to expose — "enabled" must mean "reachable".
                let _ = shutdown_tx.send(());
                return Err(err);
            }
        };
        *state.running.lock().map_err(|e| e.to_string())? = Some(RunningRelay {
            port,
            shutdown_tx,
            hostname,
        });
    } else {
        let taken = state.running.lock().map_err(|e| e.to_string())?.take();
        if let Some(running) = taken {
            let _ = running.shutdown_tx.send(());
            if let Err(err) = funnel::disable().await {
                log::warn!("failed to disable Tailscale Funnel: {err}");
            }
        }
    }
    if let Err(err) = write_persisted_enabled(&app, enabled) {
        // Best-effort: the relay itself already changed state correctly
        // above, and a failed write here only costs the *next restart*
        // remembering it — not worth failing this toggle over.
        log::warn!("failed to persist remote access setting: {err}");
    }
    relay_status(state).await
}

#[tauri::command]
pub async fn relay_status(state: tauri::State<'_, RelayState>) -> Result<RelayStatus, String> {
    let running = state.running.lock().map_err(|e| e.to_string())?;
    Ok(RelayStatus {
        enabled: running.is_some(),
        port: running.as_ref().map(|r| r.port),
        hostname: running.as_ref().and_then(|r| r.hostname.clone()),
    })
}
