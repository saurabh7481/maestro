//! The lazy `opencode serve` supervisor (docs/OPENCODE_INTEGRATION.md §2).
//!
//! ## Why this exists
//!
//! A measured idle `opencode serve` costs ~366 MB RSS — comparable to the
//! rest of Maestro combined — while booting one takes only 1–2 s. That
//! ratio inverts every usual instinct: the server must be **started only
//! when an opencode feature actually needs it** and **stopped aggressively
//! once nothing does**, which no other child process in this app has to
//! satisfy. Agent CLIs are per-turn spawns; terminals live exactly as long
//! as their tab. Only opencode has a "sometimes there is a server" state,
//! so it gets a real state machine.
//!
//! ## How laziness works: consumer reference counting
//!
//! Every consumer (open OpenCode tab, running turn, visible settings pane,
//! OAuth wait) calls [`OpencodeSidecar::acquire`] and holds the returned
//! [`SidecarGuard`] for as long as it needs the server. The guard is just
//! a counter arm — dropping it is cheap and synchronous, which matters
//! because tab-close paths shouldn't have to be async. When the count hits
//! zero, a reaper task waits out the idle grace and kills the child unless
//! someone acquired again meanwhile (the counter is re-checked after the
//! sleep, so "cancel the stop" needs no explicit cancellation path).
//!
//! Two rules from the plan are enforced by construction here and must stay
//! that way:
//! - **Detection never acquires.** `registry::detect` answers the
//!   installed/auth questions from `--version` and `auth.json`; nothing in
//!   this module is touched until a real opencode feature shows up.
//! - **App startup never acquires.** The supervisor begins `Stopped` and
//!   no restored-tab path may call `acquire` before the tab renders.
//!
//! ## Task topology (why the restart channel exists)
//!
//! All kills travel through a channel to the one task that owns the
//! `Child` (the same ownership shape `manager.rs` uses for turns), so
//! "intentional stop" and "unexpected exit" stay distinguishable. Crash
//! *restarts* equally travel through a channel: the monitor only decides,
//! and a long-lived driver task (spawned on first acquire) performs the
//! respawn. That indirection isn't decoration — `start` spawns `monitor`,
//! so if `monitor` could call `start` back, the two futures would contain
//! each other and the compiler rightly refuses to size them.
//!
//! ## Security posture
//!
//! The server binds loopback on an OS-assigned port with a per-boot random
//! password passed as `OPENCODE_SERVER_PASSWORD` (environment, never argv
//! — `/proc/<pid>/cmdline` is world-readable). Phase O1 found provider
//! keys in ordinary GET responses, so this password is load-bearing, not
//! decorative.

use crate::agents::opencode::client::{self, Endpoint};
use crate::process_ext::{resolve_executable, HiddenCommandExt};
use serde::Serialize;
use std::collections::VecDeque;
use std::net::TcpListener;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, Notify};

/// Measured boot is 1–2 s; the budget is deliberately generous because a
/// cold machine or a slow plugin load counts against it (§2.3).
const BOOT_TIMEOUT: Duration = Duration::from_secs(10);
const BOOT_POLL: Duration = Duration::from_millis(150);
/// Memory is expensive (366 MB) and boot is cheap (1–2 s), so the grace
/// period errs toward stopping: two minutes of idleness ends the server.
const IDLE_GRACE: Duration = Duration::from_secs(120);
/// One crash with consumers attached gets an immediate restart; a second
/// inside this window means something systemic is wrong and the sidecar
/// stops retrying (§2.2's crash policy).
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const STDERR_TAIL_LINES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// No process. The only state app startup and detection ever see.
    Stopped,
    /// A spawn + health wait is in flight; other acquires queue here.
    Starting,
    /// Healthy and serving. `handles` says who depends on it.
    Running,
    /// A stop has been requested (idle reaper or shutdown); acquires wait
    /// for the exit to finish rather than being handed a dying server.
    Stopping,
    /// Repeated crashes. Reported verbatim; self-heals after the crash
    /// window so the next acquire is a fresh attempt.
    Failed,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Stopped => "stopped",
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Stopping => "stopping",
            Phase::Failed => "failed",
        }
    }
}

#[derive(Debug)]
struct State {
    phase: Phase,
    pid: Option<u32>,
    port: Option<u16>,
    password: Option<String>,
    /// The one kill switch the monitor selects on. `None` whenever no
    /// child is owned (or its exit is being processed) — boot's early
    /// bail-out keys off this.
    kill_tx: Option<mpsc::UnboundedSender<()>>,
    started_at: Option<Instant>,
    last_binary: Option<String>,
    /// Timestamps of unexpected exits while `Running`, pruned to the
    /// crash window. One entry = restart eligible; two = `Failed`.
    crashes: Vec<Instant>,
    failed_at: Option<Instant>,
    last_error: Option<String>,
}

impl State {
    fn stopped() -> State {
        State {
            phase: Phase::Stopped,
            pid: None,
            port: None,
            password: None,
            kill_tx: None,
            started_at: None,
            last_binary: None,
            crashes: Vec::new(),
            failed_at: None,
            last_error: None,
        }
    }
}

#[derive(Debug)]
struct Inner {
    handles: AtomicU32,
    state: Mutex<State>,
    notify: Notify,
    /// Set once, by the first acquire, which is what spawns the restart
    /// driver. Before that there is nothing to restart.
    driver_started: AtomicBool,
    restart_tx: mpsc::UnboundedSender<String>,
    /// Held until `ensure_driver` claims it. Stored as `Option` because
    /// the constructor must stay sync (it runs in app setup, possibly
    /// before any runtime exists) while the driver needs a runtime.
    restart_rx: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    boot_timeout: Duration,
    boot_poll: Duration,
    idle_grace: Duration,
    crash_window: Duration,
}

/// Lock helper that survives a panic while a guard was held — a poisoned
/// sidecar lock must not take the whole agent subsystem down with it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    /// `stopped` | `starting` | `running` | `stopping` | `failed`
    pub phase: &'static str,
    pub handles: u32,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub uptime_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct OpencodeSidecar {
    inner: Arc<Inner>,
}

impl Default for OpencodeSidecar {
    fn default() -> Self {
        Self::new()
    }
}

/// What holding one looks like to callers: opaque, cheap to drop, and the
/// only proof of "the server owes me liveness". Hold it across the whole
/// operation — an open tab holds one for the tab's lifetime.
#[derive(Debug)]
pub struct SidecarGuard {
    inner: Arc<Inner>,
}

impl Drop for SidecarGuard {
    fn drop(&mut self) {
        let prev = self.inner.handles.fetch_sub(1, Ordering::SeqCst);
        if prev != 1 {
            return;
        }
        // Last consumer left: arm the reaper. It re-checks the counter
        // after sleeping, so an acquire landing during the grace period
        // simply outlives this task — no cancellation plumbing.
        let inner = Arc::clone(&self.inner);
        let grace = inner.idle_grace;
        let spawned = tokio::runtime::Handle::try_current().map(|handle| {
            handle.spawn(async move {
                tokio::time::sleep(grace).await;
                let mut state = lock(&inner.state);
                if inner.handles.load(Ordering::SeqCst) == 0 && state.phase == Phase::Running {
                    log::info!(
                        "opencode sidecar: idle for {:?} — stopping (freeing ~366 MB)",
                        grace
                    );
                    if let Some(tx) = state.kill_tx.take() {
                        let _ = tx.send(());
                    }
                    state.phase = Phase::Stopping;
                }
            })
        });
        if spawned.is_err() {
            // Dropped outside a runtime (shouldn't happen from commands):
            // the counter is already down; the next acquire reconciles.
            log::warn!("opencode sidecar guard dropped without a runtime to reap in");
        }
    }
}

enum Next {
    Ready,
    BeginStart,
    Wait,
    Fail(String),
}

impl OpencodeSidecar {
    pub fn new() -> Self {
        Self::with_timings(BOOT_TIMEOUT, BOOT_POLL, IDLE_GRACE, CRASH_WINDOW)
    }

    /// Production timings. Private so the constants stay authoritative;
    /// tests use `with_timings` to shrink them.
    fn with_timings(
        boot_timeout: Duration,
        boot_poll: Duration,
        idle_grace: Duration,
        crash_window: Duration,
    ) -> Self {
        let (restart_tx, restart_rx) = mpsc::unbounded_channel::<String>();
        Self {
            inner: Arc::new(Inner {
                handles: AtomicU32::new(0),
                state: Mutex::new(State::stopped()),
                notify: Notify::new(),
                driver_started: AtomicBool::new(false),
                restart_tx,
                restart_rx: Mutex::new(Some(restart_rx)),
                boot_timeout,
                boot_poll,
                idle_grace,
                crash_window,
            }),
        }
    }

    /// Acquires the server, starting it if no consumer had it running.
    ///
    /// `binary_path` is the user-configured or PATH-resolved `opencode`
    /// binary (same override chain as every other CLI). Concurrent calls
    /// coalesce: exactly one spawns, the rest wait for the same result.
    pub async fn acquire(&self, binary_path: &str) -> Result<SidecarGuard, String> {
        self.ensure_driver();
        let binary = resolve_executable(binary_path)
            .to_string_lossy()
            .into_owned();
        self.inner.handles.fetch_add(1, Ordering::SeqCst);
        loop {
            // Registered before the check so a notify fired between the
            // two can't be missed (tokio's documented Notify pattern).
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            let next = {
                let mut state = lock(&self.inner.state);
                match state.phase {
                    Phase::Running => Next::Ready,
                    Phase::Stopped => {
                        state.phase = Phase::Starting;
                        state.last_binary = Some(binary.clone());
                        Next::BeginStart
                    }
                    Phase::Starting | Phase::Stopping => Next::Wait,
                    Phase::Failed => {
                        let healed = state
                            .failed_at
                            .map(|at| at.elapsed() >= self.inner.crash_window)
                            .unwrap_or(true);
                        if healed {
                            state.phase = Phase::Starting;
                            state.last_binary = Some(binary.clone());
                            Next::BeginStart
                        } else {
                            Next::Fail(
                                state
                                    .last_error
                                    .clone()
                                    .unwrap_or_else(|| "opencode sidecar is not running".into()),
                            )
                        }
                    }
                }
            };
            match next {
                Next::Ready => {
                    return Ok(SidecarGuard {
                        inner: Arc::clone(&self.inner),
                    })
                }
                Next::BeginStart => match self.start(&binary).await {
                    Ok(()) => {
                        return Ok(SidecarGuard {
                            inner: Arc::clone(&self.inner),
                        })
                    }
                    Err(error) => {
                        self.inner.handles.fetch_sub(1, Ordering::SeqCst);
                        return Err(error);
                    }
                },
                Next::Wait => notified.await,
                Next::Fail(error) => {
                    self.inner.handles.fetch_sub(1, Ordering::SeqCst);
                    return Err(error);
                }
            }
        }
    }

    /// Snapshot for the Process Manager / settings UI. Never touches the
    /// child, never starts anything — safe from detection paths.
    pub fn status(&self) -> SidecarStatus {
        let state = lock(&self.inner.state);
        SidecarStatus {
            phase: state.phase.as_str(),
            handles: self.inner.handles.load(Ordering::SeqCst),
            pid: state.pid,
            port: state.port,
            uptime_ms: if state.phase == Phase::Running {
                state.started_at.map(|at| at.elapsed().as_millis() as u64)
            } else {
                None
            },
            last_error: state.last_error.clone(),
        }
    }

    /// Endpoint of the running server, if one is up. Callers must hold a
    /// guard — this returns the coordinates, not a liveness promise.
    pub fn endpoint(&self) -> Option<Endpoint> {
        let state = lock(&self.inner.state);
        Some(Endpoint {
            port: state.port?,
            password: state.password.clone()?,
        })
    }

    /// Like `acquire`, but never starts the server — only bumps the
    /// handle count and returns a guard if one is already running right
    /// now, atomically with the phase check (the increment happens while
    /// still holding `state`'s lock, so nothing can flip the phase out
    /// from under it in between). For callers that want to piggyback on
    /// an already-warm server without ever being the reason it boots
    /// (§2.2: opening the model picker must not itself start the
    /// sidecar) — `endpoint()` alone isn't enough for that, since it
    /// returns coordinates with no liveness promise and no held handle to
    /// stop the idle reaper from pulling the server out from under an
    /// in-flight request.
    pub fn try_acquire_running(&self) -> Option<(Endpoint, SidecarGuard)> {
        let state = lock(&self.inner.state);
        if state.phase != Phase::Running {
            return None;
        }
        let endpoint = Endpoint {
            port: state.port?,
            password: state.password.clone()?,
        };
        self.inner.handles.fetch_add(1, Ordering::SeqCst);
        Some((
            endpoint,
            SidecarGuard {
                inner: Arc::clone(&self.inner),
            },
        ))
    }

    /// Quit-path teardown. Sync on purpose: it runs from the
    /// `RunEvent::ExitRequested` callback alongside `manager::kill_all`,
    /// where `.await` isn't available. The monitor observes the kill and
    /// finishes reaping asynchronously; the process is going away anyway.
    pub fn shutdown_now(&self) {
        let mut state = lock(&self.inner.state);
        if matches!(
            state.phase,
            Phase::Running | Phase::Starting | Phase::Stopping
        ) {
            if let Some(tx) = state.kill_tx.take() {
                let _ = tx.send(());
            }
            state.phase = Phase::Stopped;
            state.pid = None;
            state.port = None;
            state.password = None;
        }
    }

    /// Spawns the restart driver exactly once, claiming the receiver the
    /// constructor stashed. Called from `acquire` because that is the one
    /// place a runtime is guaranteed to exist — constructing the sidecar
    /// (app setup) must not require one.
    fn ensure_driver(&self) {
        if self.inner.driver_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let receiver = lock(&self.inner.restart_rx).take();
        if let Some(rx) = receiver {
            let inner = Arc::clone(&self.inner);
            tokio::spawn(restart_driver(inner, rx));
        }
    }

    /// Flips `Stopped` → `Starting` iff nobody else did. Used only by the
    /// restart driver — `acquire` performs its own flip inline because it
    /// also handles the healed-`Failed` case.
    fn try_begin_start(&self, binary: &str) -> bool {
        let mut state = lock(&self.inner.state);
        if state.phase != Phase::Stopped {
            return false;
        }
        state.phase = Phase::Starting;
        state.last_binary = Some(binary.to_string());
        true
    }

    /// Spawn + health wait. Runs with no lock held across awaits; all
    /// state updates are short critical sections.
    async fn start(&self, binary: &str) -> Result<(), String> {
        let port = free_port()?;
        let password = uuid::Uuid::new_v4().to_string();
        let mut command = build_serve_command(binary, port, &password);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let detail = format!("could not start `{binary} serve`: {error}");
                let mut state = lock(&self.inner.state);
                state.phase = Phase::Failed;
                state.failed_at = Some(Instant::now());
                state.last_error = Some(detail.clone());
                self.inner.notify.notify_waiters();
                return Err(detail);
            }
        };
        let pid = child.id();
        let (kill_tx, kill_rx) = mpsc::unbounded_channel::<()>();
        {
            let mut state = lock(&self.inner.state);
            state.pid = pid;
            state.port = Some(port);
            state.password = Some(password.clone());
            state.kill_tx = Some(kill_tx);
            state.started_at = None;
            state.last_error = None;
        }

        // Both pipes must be drained or a chatty server fills its pipe
        // and blocks; stdout is discarded, stderr feeds the failure tail.
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::debug!(target: "opencode_serve", "{line}");
                }
            });
        }
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut buffer = lock(&tail);
                    if buffer.len() >= STDERR_TAIL_LINES {
                        buffer.pop_front();
                    }
                    buffer.push_back(line);
                }
            });
        }

        // The monitor exclusively owns the child from here on.
        let monitor_inner = Arc::clone(&self.inner);
        tokio::spawn(monitor(monitor_inner, child, kill_rx, tail));

        let endpoint = Endpoint { port, password };
        let deadline = Instant::now() + self.inner.boot_timeout;
        loop {
            if Instant::now() >= deadline {
                let detail = format!(
                    "opencode sidecar did not become healthy within {:?}",
                    self.inner.boot_timeout
                );
                {
                    let mut state = lock(&self.inner.state);
                    state.phase = Phase::Failed;
                    state.failed_at = Some(Instant::now());
                    state.last_error = Some(detail.clone());
                    if let Some(tx) = state.kill_tx.take() {
                        let _ = tx.send(());
                    }
                }
                self.inner.notify.notify_waiters();
                return Err(detail);
            }
            // The child dying mid-boot clears `kill_tx` (monitor) — bail
            // out immediately instead of polling a corpse for the full
            // budget.
            if lock(&self.inner.state).kill_tx.is_none() {
                let detail = "opencode sidecar exited during startup".to_string();
                let mut state = lock(&self.inner.state);
                state.phase = Phase::Failed;
                state.failed_at = Some(Instant::now());
                state.last_error.get_or_insert(detail.clone());
                self.inner.notify.notify_waiters();
                return Err(detail);
            }
            match client::healthy(&endpoint).await {
                Ok(true) => {
                    let mut state = lock(&self.inner.state);
                    state.phase = Phase::Running;
                    state.started_at = Some(Instant::now());
                    // Deliberately NOT clearing `crashes` here: the
                    // two-crashes-in-a-window policy spans boots. A
                    // server that boots fine but dies again seconds
                    // later must reach `Failed`, not flap forever;
                    // staleness is handled by the window prune instead.
                    log::info!("opencode sidecar healthy on 127.0.0.1:{port}");
                    self.inner.notify.notify_waiters();
                    return Ok(());
                }
                _ => tokio::time::sleep(self.inner.boot_poll).await,
            }
        }
    }
}

/// The one task that owns a `Child`. Selects between our kill signal
/// (intentional) and the child exiting on its own (crash), because
/// `tokio::process::Child` methods take `&mut self` — the state map can't
/// also hold it. Same ownership shape as `manager.rs`'s turn tasks.
///
/// Decides but never respawns directly: the restart request goes through
/// `inner.restart_tx` to the driver task (see the module header for why
/// that indirection is load-bearing).
async fn monitor(
    inner: Arc<Inner>,
    mut child: Child,
    mut kill_rx: mpsc::UnboundedReceiver<()>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
) {
    let intentional = tokio::select! {
        _ = kill_rx.recv() => true,
        status = child.wait() => {
            log::warn!("opencode sidecar exited on its own: {status:?}");
            false
        }
    };
    if !intentional {
        // Make sure the process is fully reaped regardless of how it died.
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    let mut restart_binary = None;
    {
        let mut state = lock(&inner.state);
        state.kill_tx = None;
        state.pid = None;
        match (intentional, state.phase) {
            (true, Phase::Running | Phase::Stopping) => {
                state.phase = Phase::Stopped;
                state.port = None;
                state.password = None;
            }
            // Intentional kills arranged by boot-failure/shutdown paths
            // already set the phase they wanted; don't clobber them.
            (true, _) => {}
            (false, Phase::Running) => {
                let now = Instant::now();
                state
                    .crashes
                    .retain(|at| now.duration_since(*at) <= inner.crash_window);
                state.crashes.push(now);
                if state.crashes.len() == 1 {
                    log::warn!("opencode sidecar crashed once — restarting");
                    state.phase = Phase::Stopped;
                    state.port = None;
                    state.password = None;
                    restart_binary = state.last_binary.clone();
                } else {
                    let tail = lock(&stderr_tail)
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>()
                        .join(" | ");
                    let detail = format!(
                        "opencode sidecar crashed repeatedly ({}) — giving up until retried. stderr: {}",
                        state.crashes.len(),
                        if tail.is_empty() { "<none captured>" } else { &tail }
                    );
                    log::error!("{detail}");
                    state.phase = Phase::Failed;
                    state.failed_at = Some(now);
                    state.last_error = Some(detail);
                }
            }
            // Crashed during boot: the boot loop reports the failure.
            (false, _) => {}
        }
    }
    inner.notify.notify_waiters();

    if let Some(binary) = restart_binary {
        // Immediate restart, but only because consumers are still attached
        // (checked here, at the moment of decision). If they left in the
        // meantime, the reaper will stop any fresh instance after grace.
        if inner.handles.load(Ordering::SeqCst) > 0 {
            let _ = inner.restart_tx.send(binary);
        }
    }
}

/// Consumes restart requests produced by the monitor. Spawned by the
/// first `acquire` — never by `start` — so the future graph stays finite
/// (module header, "Task topology").
async fn restart_driver(inner: Arc<Inner>, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(binary) = rx.recv().await {
        if inner.handles.load(Ordering::SeqCst) == 0 {
            continue;
        }
        let sidecar = OpencodeSidecar {
            inner: Arc::clone(&inner),
        };
        if sidecar.try_begin_start(&binary) {
            let _ = sidecar.start(&binary).await;
        }
    }
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("no free local port for opencode sidecar: {e}"))?
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("opencode sidecar port discovery failed: {e}"))
}

fn build_serve_command(binary: &str, port: u16, password: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(resolve_executable(binary));
    command.hide_window();
    command.args([
        "serve",
        "--port",
        &port.to_string(),
        "--hostname",
        "127.0.0.1",
    ]);
    // Environment, never argv: `/proc/<pid>/cmdline` is world-readable.
    command.env("OPENCODE_SERVER_PASSWORD", password);
    // A background updater prompt and surprise session sharing have no
    // business inside a managed child.
    command.env("OPENCODE_DISABLE_AUTOUPDATE", "true");
    command.env("OPENCODE_AUTO_SHARE", "false");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // Belt-and-suspenders for any drop path that bypasses `shutdown_now`.
    command.kill_on_drop(true);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------- fakes

    // The shebang must be byte zero — a leading newline makes exec(2)
    // fail with ENOEXEC ("Exec format error"), which cost one test run.
    // Behavior is driven by a `mode` file next to the binary rather than
    // an environment variable: parallel tests share process env, but
    // each gets its own tempdir.
    const FAKE_SCRIPT: &str = r#"#!/usr/bin/env python3
import os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
here = os.path.dirname(os.path.abspath(__file__))
mode_path = os.path.join(here, "mode")
mode = open(mode_path).read().strip() if os.path.exists(mode_path) else "healthy"

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/die"):
            os._exit(9)
        if mode != "healthy" or not self.path.startswith("/global/health"):
            self.send_response(500)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            return
        body = b'{"healthy": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
"#;

    fn python3_available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    fn write_fake_binary(dir: &std::path::Path) -> String {
        let path = dir.join("fake-opencode");
        std::fs::write(&path, FAKE_SCRIPT).expect("write fake binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake binary");
        }
        path.to_string_lossy().into_owned()
    }

    fn set_fake_mode(dir: &std::path::Path, mode: &str) {
        std::fs::write(dir.join("mode"), mode).expect("write mode file");
    }

    fn test_sidecar() -> OpencodeSidecar {
        OpencodeSidecar::with_timings(
            Duration::from_secs(6),
            Duration::from_millis(50),
            Duration::from_millis(400),
            Duration::from_secs(3),
        )
    }

    async fn wait_for_phase(sidecar: &OpencodeSidecar, phase: &str, budget: Duration) -> bool {
        wait_until(sidecar, |s| s.phase == phase, budget).await
    }

    async fn wait_until(
        sidecar: &OpencodeSidecar,
        predicate: impl Fn(&SidecarStatus) -> bool,
        budget: Duration,
    ) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            if predicate(&sidecar.status()) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn trigger_crash(sidecar: &OpencodeSidecar) {
        let port = sidecar.status().port.expect("running sidecar has a port");
        // The fake exits mid-request; the error is the point.
        let _ = reqwest::get(format!("http://127.0.0.1:{port}/die")).await;
    }

    // ------------------------------------------------------------ tests

    #[tokio::test(flavor = "multi_thread")]
    async fn starts_only_on_demand_and_stops_after_grace() {
        if !python3_available() {
            eprintln!("skipping: python3 unavailable");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = write_fake_binary(dir.path());
        let sidecar = test_sidecar();

        // Before any consumer: nothing exists. This is the "+0 MB idle"
        // budget from §2.3, asserted rather than aspirational.
        assert_eq!(sidecar.status().phase, "stopped");

        let guard = sidecar.acquire(&binary).await.unwrap();
        assert_eq!(sidecar.status().phase, "running");
        let port = sidecar.status().port.unwrap();
        assert!(client::healthy(&sidecar.endpoint().unwrap()).await.unwrap());

        // Dropped but inside the grace window: still alive.
        drop(guard);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sidecar.status().phase, "running");
        assert_eq!(sidecar.status().port, Some(port));

        // Grace elapsed: gone, and the port is actually released.
        assert!(wait_for_phase(&sidecar, "stopped", Duration::from_secs(3)).await);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "port {port} should be released after the sidecar stops"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn acquire_during_grace_keeps_the_same_server() {
        if !python3_available() {
            eprintln!("skipping: python3 unavailable");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = write_fake_binary(dir.path());
        let sidecar = test_sidecar();

        let first = sidecar.acquire(&binary).await.unwrap();
        let port = sidecar.status().port.unwrap();
        drop(first);

        // Re-acquire halfway through the grace period: the reaper must
        // find handles > 0 and leave this instance alone.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let second = sidecar.acquire(&binary).await.unwrap();
        assert_eq!(sidecar.status().phase, "running");
        assert_eq!(sidecar.status().port, Some(port), "same server reused");
        drop(second);

        assert!(wait_for_phase(&sidecar, "stopped", Duration::from_secs(3)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_acquires_share_one_process() {
        if !python3_available() {
            eprintln!("skipping: python3 unavailable");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = write_fake_binary(dir.path());
        let sidecar = std::sync::Arc::new(test_sidecar());

        let first = tokio::spawn({
            let sidecar = Arc::clone(&sidecar);
            let binary = binary.clone();
            async move { sidecar.acquire(&binary).await }
        });
        let second = tokio::spawn({
            let sidecar = Arc::clone(&sidecar);
            async move { sidecar.acquire(&binary).await }
        });
        let (a, b) = (
            first.await.unwrap().unwrap(),
            second.await.unwrap().unwrap(),
        );

        let status = sidecar.status();
        assert_eq!(status.phase, "running");
        assert_eq!(status.handles, 2, "both consumers counted");

        drop(a);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sidecar.status().phase, "running", "b still holds it");
        drop(b);
        assert!(wait_for_phase(&sidecar, "stopped", Duration::from_secs(3)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn boot_failure_marks_failed_and_fails_closed() {
        if !python3_available() {
            eprintln!("skipping: python3 unavailable");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = write_fake_binary(dir.path());
        set_fake_mode(dir.path(), "unhealthy");
        let sidecar = test_sidecar();

        // The fake serves 500s: boot must exhaust its budget, report a
        // real error, and land in `failed` — not silently look stopped.
        let error = sidecar.acquire(&binary).await.unwrap_err();
        assert!(error.contains("healthy"), "got: {error}");
        let status = sidecar.status();
        assert_eq!(status.phase, "failed");
        assert!(status.last_error.is_some());

        // The failed acquire must not leak its handle.
        assert_eq!(status.handles, 0);

        // Within the retry window, further acquires fail fast with the
        // same story instead of re-spawning a known-bad server.
        assert!(sidecar.acquire(&binary).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn crash_restarts_once_then_marks_failed() {
        if !python3_available() {
            eprintln!("skipping: python3 unavailable");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = write_fake_binary(dir.path());
        let sidecar = std::sync::Arc::new(test_sidecar());

        let guard = sidecar.acquire(&binary).await.unwrap();
        let first_pid = sidecar.status().pid.unwrap();

        // First unexpected exit with a consumer attached: immediate
        // restart. Waiting on the *pid identity* rather than the phase —
        // the pre-crash state also reads "running", and the fresh boot
        // could in principle reuse the old port.
        trigger_crash(&sidecar).await;
        assert!(
            wait_until(
                &sidecar,
                |s| s.phase == "running" && s.pid != Some(first_pid),
                Duration::from_secs(5)
            )
            .await,
            "sidecar should restart after one crash"
        );

        // Second crash inside the window: give up honestly.
        trigger_crash(&sidecar).await;
        assert!(wait_for_phase(&sidecar, "failed", Duration::from_secs(5)).await);
        let status = sidecar.status();
        assert!(status.last_error.unwrap_or_default().contains("crashed"));

        // While failed, acquire refuses instead of pretending.
        assert!(sidecar.acquire(&binary).await.is_err());
        drop(guard);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_now_kills_the_child_immediately() {
        if !python3_available() {
            eprintln!("skipping: python3 unavailable");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = write_fake_binary(dir.path());
        let sidecar = test_sidecar();

        let guard = sidecar.acquire(&binary).await.unwrap();
        let port = sidecar.status().port.unwrap();

        sidecar.shutdown_now();
        assert_eq!(sidecar.status().phase, "stopped");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "quit teardown must release the port"
        );
        drop(guard);
    }

    #[test]
    fn serve_command_carries_port_password_and_quiet_env() {
        let command = build_serve_command("/usr/bin/opencode", 4567, "secret-pw");
        let std_command = command.as_std();
        let args: Vec<String> = std_command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["serve", "--port", "4567", "--hostname", "127.0.0.1"]);

        let envs: std::collections::HashMap<_, _> = std_command
            .get_envs()
            .filter_map(|(k, v)| v.map(|v| (k, v)))
            .collect();
        assert_eq!(
            envs.get(std::ffi::OsStr::new("OPENCODE_SERVER_PASSWORD")),
            Some(&std::ffi::OsStr::new("secret-pw")),
            "the password travels by environment, never argv"
        );
        assert_eq!(
            std_command.get_program().to_string_lossy(),
            "/usr/bin/opencode"
        );
    }

    #[test]
    fn free_ports_do_not_collide() {
        let a = free_port().unwrap();
        let b = free_port().unwrap();
        assert_ne!(a, b, "OS-assigned ports should not collide back-to-back");
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Opt-in soak against the REAL `opencode` binary — run with
    /// `OPENCODE_LIVE=1 cargo test --lib opencode`. Skipped silently
    /// otherwise, and skipped wherever `opencode` isn't installed.
    ///
    /// Validates the three things fake binaries can't: boot latency
    /// against the real server's actual startup work, RSS stability over
    /// a short soak (the multi-hour watch stays a release-hardening
    /// manual step), and crash recovery when the process is killed from
    /// outside Maestro — the "user ran pkill" scenario §2.2 promises to
    /// survive.
    #[tokio::test(flavor = "multi_thread")]
    async fn real_binary_lifecycle_boot_rss_and_external_kill() {
        if std::env::var("OPENCODE_LIVE").as_deref() != Ok("1") {
            eprintln!("skipping: set OPENCODE_LIVE=1 to run");
            return;
        }
        let binary = match which_opencode() {
            Some(path) => path,
            None => {
                eprintln!("skipping: opencode not on PATH");
                return;
            }
        };
        let sidecar = OpencodeSidecar::with_timings(
            Duration::from_secs(15),
            Duration::from_millis(100),
            Duration::from_secs(3),
            Duration::from_secs(60),
        );

        // Boot latency budget: ≤ 3 s p95 (§2.3). Measured, not assumed.
        let boot_started = Instant::now();
        let guard = sidecar.acquire(&binary).await.expect("real acquire");
        let boot_ms = boot_started.elapsed().as_millis() as u64;
        println!("live: boot-to-healthy {boot_ms} ms");
        assert!(
            boot_ms <= 5_000,
            "boot took {boot_ms} ms — over even the generous budget"
        );

        // Short soak: RSS sampled twice, 20 s apart. Growth beyond ~50 MB
        // in under a minute would mean the server warms up unboundedly;
        // the multi-hour check is O7's manual release step.
        let first = sample_rss_mb(sidecar.status().pid.expect("pid while running"));
        tokio::time::sleep(Duration::from_secs(20)).await;
        let second = sample_rss_mb(sidecar.status().pid.unwrap());
        println!("live: rss {first:?} → {second:?} MB after 20 s");
        if let (Some(before), Some(after)) = (first, second) {
            assert!(
                after.saturating_sub(before) <= 50,
                "rss grew {before} → {after} MB in 20 s"
            );
        }

        // External kill with a consumer attached: the supervisor must
        // restart onto a fresh pid without the guard noticing anything
        // but a brief blip.
        let original_pid = sidecar.status().pid.unwrap();
        external_kill9(original_pid);
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let status = sidecar.status();
            if status.phase == "running" && status.pid != Some(original_pid) {
                println!(
                    "live: restarted onto pid {:?} after external kill",
                    status.pid
                );
                break;
            }
            assert!(Instant::now() < deadline, "no restart after external kill");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        drop(guard);
        let stopped = {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if sidecar.status().phase == "stopped" {
                    break true;
                }
                if Instant::now() >= deadline {
                    break false;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        };
        assert!(stopped, "sidecar did not stop after grace");
    }

    fn which_opencode() -> Option<String> {
        let path = std::env::var("PATH").ok()?;
        std::env::split_paths(&path)
            .map(|dir| dir.join("opencode"))
            .find(|candidate| candidate.is_file())
            .map(|p| p.to_string_lossy().into_owned())
    }

    #[cfg(target_os = "linux")]
    fn sample_rss_mb(pid: u32) -> Option<u64> {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
        line.split_whitespace()
            .nth(1)?
            .parse::<u64>()
            .ok()
            .map(|kb| kb / 1024)
    }

    #[cfg(not(target_os = "linux"))]
    fn sample_rss_mb(_pid: u32) -> Option<u64> {
        None
    }

    /// Kills a process we own by pid. Only ever aimed at the sidecar
    /// child this test spawned.
    fn external_kill9(pid: u32) {
        #[cfg(unix)]
        {
            let ok = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false);
            assert!(ok, "external kill of {pid} failed");
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            panic!("external-kill scenario is unix-only");
        }
    }
}
