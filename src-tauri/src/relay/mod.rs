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
pub use funnel::FunnelReport;

/// Failures that aren't about Tailscale setup at all (a poisoned mutex, a
/// socket that wouldn't bind) still have to reach the UI in the one shape
/// it renders, so they arrive as `Unknown` with their own text in
/// `detail` rather than as a second error type.
fn internal_error(error: impl std::fmt::Display) -> FunnelReport {
    funnel::internal(error.to_string())
}

const RELAY_ENABLED_SETTING_KEY: &str = "relay.enabled";

/// Fired whenever the set of agent/terminal sessions — or anything the
/// session list displays about one — changes: created, retitled, status
/// moved, disposed. Carries no payload; a listener re-reads
/// `processes::session_rows`, which is cheap.
///
/// Pushing the whole list rather than a delta is deliberate. The list is
/// tens of rows, and a full-state push has no way to drift: a dropped or
/// reordered delta would leave a client subtly wrong forever, which is
/// exactly the class of bug this whole change exists to remove.
pub const SESSIONS_CHANGED_CHANNEL: &str = "agent-sessions://changed";

pub fn notify_sessions_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(SESSIONS_CHANGED_CHANNEL, ());
}

/// Whether remote access was last left on. Defaults to `false` so a fresh
/// install — one that has never touched the toggle — starts with the relay
/// off and nothing exposed; after that the stored value is authoritative in
/// both directions, and only the user flipping the Settings toggle changes
/// it.
pub fn read_enabled(conn: &rusqlite::Connection) -> bool {
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

fn write_enabled(conn: &rusqlite::Connection, enabled: bool) -> Result<(), String> {
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

fn write_persisted_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let conn = app_state.db.lock().map_err(|e| e.to_string())?;
    write_enabled(&conn, enabled)
}

/// How long to keep trying to bring the relay back up on startup, as
/// delays between attempts (the first is immediate).
///
/// Restoring is not a one-shot: Maestro commonly launches at login, *next
/// to* Tailscale rather than after it, and `funnel::enable`'s preflight
/// fails outright while the daemon is still connecting ("installed but not
/// logged in"). A single attempt at t=0 therefore loses remote access for
/// the whole session on exactly the restart the user is most likely to be
/// away from the machine for — the setting says on, the relay is off, and
/// nothing ever reconciles the two. Spread over ~3.5 minutes this rides
/// out a cold boot; past that it's a real misconfiguration to report, not
/// a race to wait on.
const RESTORE_RETRY_DELAYS_SECS: [u64; 5] = [5, 10, 30, 60, 120];

/// Brings the relay back up if the Settings toggle was last left on.
/// Called once from `lib.rs`'s `.setup()`; never flips the stored setting
/// itself, so a startup that can't reach Tailscale leaves "enabled" intact
/// for the next launch rather than silently opting the user out.
pub async fn restore_persisted(app: tauri::AppHandle) {
    let should_enable = match app.state::<AppState>().db.lock() {
        Ok(conn) => read_enabled(&conn),
        Err(_) => false,
    };
    if !should_enable {
        return;
    }

    let mut last_error = String::new();
    for (attempt, delay) in std::iter::once(0)
        .chain(RESTORE_RETRY_DELAYS_SECS)
        .enumerate()
    {
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        }
        // Re-read each time: the user may have opened Settings and turned
        // remote access off (or on, which already started it) while these
        // retries were still pending.
        let still_wanted = match app.state::<AppState>().db.lock() {
            Ok(conn) => read_enabled(&conn),
            Err(_) => false,
        };
        if !still_wanted {
            return;
        }

        let state = app.state::<RelayState>();
        match set_relay_enabled(app.clone(), state, true).await {
            Ok(_) => {
                if attempt > 0 {
                    log::info!("Remote access restored on startup after {attempt} retries");
                }
                return;
            }
            Err(report) => {
                last_error = format!("{}: {}", report.title, report.message);
                // A settled condition — Tailscale not installed, Funnel
                // never enabled for the tailnet — won't resolve by
                // waiting, so report it now instead of retrying for
                // minutes. The Settings pane shows the same diagnosis with
                // a link to the fix.
                if !report.state.worth_retrying() {
                    break;
                }
            }
        }
    }
    log::error!("Failed to restore remote access on startup: {last_error}");
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
) -> Result<RelayStatus, FunnelReport> {
    if enabled {
        let already_running = state.running.lock().map_err(internal_error)?.is_some();
        if already_running {
            return relay_status(state).await.map_err(internal_error);
        }
        let (port, shutdown_tx) = server::serve(app.clone()).await.map_err(internal_error)?;
        let hostname = match funnel::enable(port).await {
            Ok(hostname) => Some(hostname),
            Err(report) => {
                // Roll back: don't leave a relay server running that
                // Funnel failed to expose — "enabled" must mean "reachable".
                let _ = shutdown_tx.send(());
                return Err(report);
            }
        };
        *state.running.lock().map_err(internal_error)? = Some(RunningRelay {
            port,
            shutdown_tx,
            hostname,
        });
    } else {
        let taken = state.running.lock().map_err(internal_error)?.take();
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
    relay_status(state).await.map_err(internal_error)
}

/// Read-only diagnosis of whether remote access *can* be turned on, so the
/// Settings pane can show which setup step is missing (and link at its fix)
/// before the user flips a toggle that would only snap back. Changes
/// nothing — see `funnel::check`.
#[tauri::command]
pub async fn check_funnel() -> FunnelReport {
    funnel::check().await
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the `settings` table matters here; `db::open` needs a real
    /// app-data directory, which a unit test has no business creating.
    fn settings_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_fresh_install_has_remote_access_off() {
        assert!(!read_enabled(&settings_db()));
    }

    #[test]
    fn the_toggle_survives_a_restart_in_both_directions() {
        let conn = settings_db();

        write_enabled(&conn, true).unwrap();
        assert!(read_enabled(&conn), "enabling must outlive the process");

        write_enabled(&conn, false).unwrap();
        assert!(!read_enabled(&conn), "disabling must outlive it too");

        // Re-enabling overwrites rather than colliding on the primary key.
        write_enabled(&conn, true).unwrap();
        assert!(read_enabled(&conn));
    }

    /// A corrupt or hand-edited row must not read as "on" — failing open
    /// would expose the relay on a machine whose user never asked for it.
    #[test]
    fn an_unreadable_stored_value_falls_back_to_off() {
        let conn = settings_db();
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)",
            rusqlite::params![RELAY_ENABLED_SETTING_KEY, "not-json"],
        )
        .unwrap();
        assert!(!read_enabled(&conn));
    }

    /// The retry window has to outlast a cold boot racing the Tailscale
    /// daemon, without turning into an unbounded background loop.
    #[test]
    fn the_startup_retry_window_covers_a_slow_tailscale_start() {
        let total: u64 = RESTORE_RETRY_DELAYS_SECS.iter().sum();
        assert!((120..=600).contains(&total), "retry window was {total}s");
    }
}
