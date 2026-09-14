//! Shells out to the `tailscale` CLI to expose the relay's local port
//! publicly over Tailscale Funnel, to discover the public hostname Funnel
//! serves it on, and — before any of that — to work out whether this
//! machine is actually *able* to. Mirrors `git.rs::run_git`'s shell-out
//! shape (`tokio::process::Command` + `.hide_window()` + status/stderr
//! check), the established convention in this codebase for invoking an
//! external CLI.
//!
//! Remote access has a four-step setup a user can be stuck at any point
//! of — Tailscale installed, daemon running, logged in, and Funnel enabled
//! for the tailnet — and only the first is something they'd think to check.
//! [`check`] diagnoses which step is missing *without* turning anything on,
//! so the Settings pane can say which one and link straight at the fix,
//! rather than letting the user flip a toggle that snaps back with a raw
//! CLI error. The same [`FunnelReport`] is what a failed enable returns, so
//! there is one vocabulary for "why remote access isn't working" rather
//! than two.
//!
//! CLI mechanics below were confirmed against a real, installed Tailscale
//! (v1.102.3) rather than guessed:
//! - `tailscale funnel --bg <port>` turns Funnel on for that local port and
//!   keeps running it in the background after the command returns.
//! - `tailscale funnel --https=443 off` turns it off — keyed by the
//!   *public* HTTPS port (443), not the local port being forwarded.
//! - `tailscale status --json` always succeeds when the daemon is up;
//!   `.BackendState` is `"Running"` once logged into a tailnet, and
//!   `.Self.DNSName` (trailing dot stripped) / `.Self.ID` give this node's
//!   MagicDNS hostname and node ID respectively.
//! - `.Self.CapMap` is a map of the capabilities the *tailnet* grants this
//!   node. Live output on a Funnel-enabled tailnet contains the keys
//!   `"funnel"`, `"https"` and
//!   `"https://tailscale.com/cap/funnel-ports?ports=443,8443,10000"`; a
//!   tailnet that never opted into Funnel is missing them. Reading this is
//!   how [`check`] can report "Funnel isn't enabled for your tailnet"
//!   without first attempting to serve anything publicly.
//! - Funnel's one-time tailnet/account-level enable lives at
//!   `https://login.tailscale.com/f/funnel?node=<NodeID>`.

use crate::process_ext::{resolve_executable, HiddenCommandExt};
use serde::Serialize;
use tokio::process::Command;

const INSTALL_URL: &str = "https://tailscale.com/download";
const FUNNEL_DOCS_URL: &str = "https://tailscale.com/kb/1223/funnel";
const HTTPS_SETTINGS_URL: &str = "https://login.tailscale.com/admin/dns";

/// Which setup step (if any) is blocking remote access. Ordered roughly as
/// a user encounters them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FunnelState {
    /// Everything checks out — the toggle should work.
    Ready,
    /// No `tailscale` binary on PATH.
    NotInstalled,
    /// Binary present, but `tailscaled` isn't answering.
    DaemonNotRunning,
    /// Daemon up, no tailnet account attached yet.
    NeedsLogin,
    /// Logged in, but an admin still has to approve this machine.
    NeedsMachineAuth,
    /// Logged in but Tailscale is switched off (`tailscale down`).
    Stopped,
    /// Mid-connect; not an error, just not ready *yet*.
    Starting,
    /// Connected, but the tailnet has never opted into Funnel.
    FunnelNotEnabled,
    /// Funnel allowed but HTTPS certificates aren't enabled for the
    /// tailnet — Funnel can't serve without them.
    HttpsNotEnabled,
    /// Something else went wrong; `detail` carries the CLI's own words.
    Unknown,
}

impl FunnelState {
    /// True for the states where "turn remote access on" is guaranteed to
    /// fail, so the Settings toggle can refuse rather than snap back.
    /// Serialized onto every [`FunnelReport`] so the frontend reads this
    /// judgement instead of re-deriving it from a list of state names that
    /// would then have to be kept in sync.
    ///
    /// Deliberately excludes the capability-derived states
    /// (`FunnelNotEnabled`/`HttpsNotEnabled`) and `Unknown`: those come
    /// from reading a field that older or future Tailscale builds may
    /// shape differently, and a wrong guess there would lock a user out of
    /// a setup that actually works. They still show their guidance — they
    /// just don't block the attempt.
    pub fn blocks_enabling(self) -> bool {
        matches!(
            self,
            FunnelState::NotInstalled
                | FunnelState::DaemonNotRunning
                | FunnelState::NeedsLogin
                | FunnelState::NeedsMachineAuth
                | FunnelState::Stopped
        )
    }

    /// True for states a cold boot passes *through* — Maestro commonly
    /// launches alongside Tailscale rather than after it, so at t=0 the
    /// daemon may not be answering and may briefly report itself as
    /// signed out before its state loads. `restore_persisted` retries
    /// these. The rest are settled conditions (no binary installed, a
    /// tailnet that never opted into Funnel, a machine awaiting admin
    /// approval): retrying them for minutes would just be noise.
    pub fn worth_retrying(self) -> bool {
        matches!(
            self,
            FunnelState::DaemonNotRunning
                | FunnelState::NeedsLogin
                | FunnelState::Starting
                | FunnelState::Unknown
        )
    }
}

/// A diagnosis, phrased for display. Used both as the "here's what's
/// missing" banner in Settings and as the error a failed enable rejects
/// with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunnelReport {
    pub state: FunnelState,
    /// Whether turning remote access on is pointless from here — see
    /// [`FunnelState::blocks_enabling`].
    pub blocks_enabling: bool,
    /// Short headline: "Tailscale isn't installed".
    pub title: String,
    /// One or two plain sentences naming the actual next step.
    pub message: String,
    /// A page that fixes it, offered as a button. `None` when the fix is
    /// local (start the daemon, run `tailscale up`).
    pub help_url: Option<String>,
    /// Label for that button — "Install Tailscale", "Enable Funnel".
    pub help_label: Option<String>,
    /// A command the user can run themselves, shown verbatim where that's
    /// the real fix.
    pub command: Option<String>,
    /// The CLI's own output, kept for a details disclosure. Empty when the
    /// diagnosis came from parsed status rather than a failure.
    pub detail: String,
}

/// Boxed in every `Result` below, for the same reason `git_remote.rs`
/// boxes its own: six heap fields of user-facing prose put the `Err`
/// variant at 152 bytes, which `clippy::result_large_err` flags and which
/// would widen every `Result` in the call chain for a value that only
/// exists once setup has already gone wrong.
pub type FunnelResult<T> = Result<T, Box<FunnelReport>>;

impl FunnelReport {
    fn new(state: FunnelState, title: &str, message: &str) -> Self {
        FunnelReport {
            state,
            blocks_enabling: state.blocks_enabling(),
            title: title.to_string(),
            message: message.to_string(),
            help_url: None,
            help_label: None,
            command: None,
            detail: String::new(),
        }
    }

    fn with_help(mut self, url: &str, label: &str) -> Self {
        self.help_url = Some(url.to_string());
        self.help_label = Some(label.to_string());
        self
    }

    fn with_command(mut self, command: &str) -> Self {
        self.command = Some(command.to_string());
        self
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }

    /// For failures that never involved Tailscale — a poisoned mutex, a
    /// port that wouldn't bind. Reported in the same shape so the UI has
    /// one error surface, not two.
    pub fn internal(detail: String) -> Self {
        FunnelReport::new(
            FunnelState::Unknown,
            "Couldn't start the relay",
            "Remote access couldn't be turned on. See the details below.",
        )
        .with_detail(detail)
    }

    pub fn ready() -> Self {
        FunnelReport::new(
            FunnelState::Ready,
            "Ready",
            "Tailscale is connected and Funnel is available.",
        )
    }
}

/// "Couldn't run it at all" and "it ran and said no" are different
/// diagnoses at every call site here — the first is always "Tailscale
/// isn't installed", the second needs its message read. Distinguished by
/// type rather than by sniffing the error string.
enum CliFailure {
    /// The binary couldn't be spawned; carries the lookup detail.
    NotFound(String),
    /// It ran and exited non-zero; carries stderr.
    Failed(String),
}

async fn run_tailscale(args: &[&str]) -> Result<String, CliFailure> {
    let exe = resolve_executable("tailscale");
    let output = Command::new(&exe)
        .args(args)
        .hide_window()
        .output()
        .await
        .map_err(|e| CliFailure::NotFound(format!("{}: {e}", exe.display())))?;

    if !output.status.success() {
        return Err(CliFailure::Failed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn not_installed_report(detail: &str) -> FunnelReport {
    FunnelReport::new(
        FunnelState::NotInstalled,
        "Tailscale isn't installed",
        "Remote access works over Tailscale Funnel, which needs the Tailscale app on this computer. Install it, sign in, then come back here.",
    )
    .with_help(INSTALL_URL, "Install Tailscale")
    .with_detail(detail)
}

/// `tailscale status` failing usually means the daemon isn't up — the CLI
/// says so in several different wordings across platforms and versions, so
/// this matches loosely and falls back to `Unknown` rather than asserting.
fn status_failure_report(failure: &CliFailure) -> FunnelReport {
    let err = match failure {
        CliFailure::NotFound(detail) => return not_installed_report(detail),
        CliFailure::Failed(stderr) => stderr.as_str(),
    };
    let lower = err.to_lowercase();
    if lower.contains("failed to connect to local")
        || lower.contains("is tailscaled running")
        || lower.contains("doesn't appear to be running")
        || lower.contains("connection refused")
        || lower.contains("cannot connect to")
    {
        return FunnelReport::new(
            FunnelState::DaemonNotRunning,
            "Tailscale isn't running",
            "Tailscale is installed but its background service isn't running. Start the Tailscale app (or its service), then recheck.",
        )
        .with_command(if cfg!(target_os = "linux") {
            "sudo systemctl start tailscaled"
        } else {
            "tailscale up"
        })
        .with_detail(err);
    }
    FunnelReport::new(
        FunnelState::Unknown,
        "Couldn't check Tailscale",
        "Tailscale didn't report its status. See the details below.",
    )
    .with_detail(err)
}

async fn status_json() -> FunnelResult<serde_json::Value> {
    let raw = run_tailscale(&["status", "--json"])
        .await
        .map_err(|e| Box::new(status_failure_report(&e)))?;
    serde_json::from_str(&raw).map_err(|e| {
        Box::new(
            FunnelReport::new(
                FunnelState::Unknown,
                "Couldn't read Tailscale's status",
                "Tailscale returned something this version of Maestro couldn't parse.",
            )
            .with_detail(format!("failed to parse `tailscale status --json`: {e}")),
        )
    })
}

/// This node's MagicDNS hostname, trailing dot stripped (`tailscale
/// status --json`'s `Self.DNSName` is fully-qualified, e.g.
/// `"my-laptop.tailxxxx.ts.net."`).
async fn hostname_from_status() -> FunnelResult<String> {
    let status = status_json().await?;
    let dns_name = status
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Box::new(FunnelReport::new(
                FunnelState::Unknown,
                "Tailscale didn't report a hostname",
                "The relay is running locally but Tailscale didn't say what public name it's reachable under.",
            ))
        })?;
    Ok(dns_name.trim_end_matches('.').to_string())
}

fn self_node_id(status: &serde_json::Value) -> Option<String> {
    status
        .get("Self")
        .and_then(|s| s.get("ID"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// The capability names this tailnet grants this node, from whichever of
/// the two fields the installed Tailscale populates.
///
/// `Self.CapMap` is the current shape (a map); `Self.Capabilities` is the
/// older flat list, still emitted by 1.102 alongside it and explicitly
/// deprecated. Returns `None` — meaning "don't draw any conclusion" —
/// when neither is present, so a build that stops emitting both is never
/// mistaken for a tailnet that lost its Funnel permission.
fn granted_capabilities(status: &serde_json::Value) -> Option<Vec<String>> {
    let self_ = status.get("Self")?;
    if let Some(map) = self_.get("CapMap").and_then(|v| v.as_object()) {
        return Some(map.keys().cloned().collect());
    }
    if let Some(list) = self_.get("Capabilities").and_then(|v| v.as_array()) {
        return Some(
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        );
    }
    None
}

fn funnel_not_enabled_report(node_id: Option<&str>) -> FunnelReport {
    let url = match node_id {
        Some(id) => format!("https://login.tailscale.com/f/funnel?node={id}"),
        None => FUNNEL_DOCS_URL.to_string(),
    };
    FunnelReport::new(
        FunnelState::FunnelNotEnabled,
        "Funnel isn't enabled for your tailnet",
        "Tailscale is connected, but Funnel — the part that makes this machine reachable from outside your tailnet — has to be switched on once for your account. You'll need to be a tailnet admin, or ask one.",
    )
    .with_help(&url, "Enable Funnel")
}

fn https_not_enabled_report() -> FunnelReport {
    FunnelReport::new(
        FunnelState::HttpsNotEnabled,
        "HTTPS certificates aren't enabled",
        "Funnel serves over HTTPS, so your tailnet needs HTTPS certificates turned on in the Tailscale admin console (DNS → HTTPS Certificates).",
    )
    .with_help(HTTPS_SETTINGS_URL, "Open Tailscale DNS settings")
}

/// Free function mirror of [`FunnelReport::internal`], for `mod.rs`'s
/// `map_err` call sites.
pub fn internal(detail: String) -> Box<FunnelReport> {
    Box::new(FunnelReport::internal(detail))
}

/// Diagnoses whether remote access can be turned on, changing nothing.
///
/// Never returns an error — a failure to check *is* one of the answers.
pub async fn check() -> FunnelReport {
    match status_json().await {
        Ok(status) => classify_status(&status),
        Err(report) => *report,
    }
}

/// The diagnosis itself, given a parsed `tailscale status --json`. Split
/// from [`check`] so every branch is testable against recorded output
/// instead of needing a machine in that state.
fn classify_status(status: &serde_json::Value) -> FunnelReport {
    let backend_state = status
        .get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match backend_state {
        "Running" => {}
        "NeedsLogin" | "NoState" => {
            return FunnelReport::new(
                FunnelState::NeedsLogin,
                "Tailscale isn't signed in",
                "Tailscale is running but isn't signed into a tailnet yet. Sign in from the Tailscale app, then recheck.",
            )
            .with_command("tailscale up")
            .with_detail(format!("BackendState: {backend_state}"));
        }
        "NeedsMachineAuth" => {
            return FunnelReport::new(
                FunnelState::NeedsMachineAuth,
                "This machine needs approval",
                "Your tailnet requires an admin to approve new devices, and this one is still waiting. Approve it in the Tailscale admin console, then recheck.",
            )
            .with_help(
                "https://login.tailscale.com/admin/machines",
                "Open admin console",
            )
            .with_detail(format!("BackendState: {backend_state}"));
        }
        "Stopped" => {
            return FunnelReport::new(
                FunnelState::Stopped,
                "Tailscale is switched off",
                "Tailscale is signed in but currently disconnected. Turn it back on, then recheck.",
            )
            .with_command("tailscale up")
            .with_detail(format!("BackendState: {backend_state}"));
        }
        "Starting" => {
            return FunnelReport::new(
                FunnelState::Starting,
                "Tailscale is still connecting",
                "Tailscale is coming up. This usually clears within a few seconds — recheck in a moment.",
            )
            .with_command("tailscale status")
            .with_detail(format!("BackendState: {backend_state}"));
        }
        other => {
            return FunnelReport::new(
                FunnelState::Unknown,
                "Tailscale isn't connected",
                "Tailscale reported a state Maestro doesn't recognise. Open the Tailscale app to check on it.",
            )
            .with_detail(format!("BackendState: {other}"));
        }
    }

    // Connected. The remaining two gates are tailnet-level opt-ins, which
    // the capability map answers without touching anything.
    if let Some(caps) = granted_capabilities(status) {
        let has = |name: &str| caps.iter().any(|c| c == name);
        if !has("funnel") {
            return funnel_not_enabled_report(self_node_id(status).as_deref());
        }
        if !has("https") {
            return https_not_enabled_report();
        }
    }

    FunnelReport::ready()
}

/// Turns Funnel on for `port` and returns the public hostname it's now
/// reachable on.
///
/// Re-runs [`check`] first rather than trusting a stale banner: the state
/// can change between the pane rendering and the user flipping the toggle,
/// and a specific "Tailscale isn't signed in" beats whatever `tailscale
/// funnel` would have said about it.
pub async fn enable(port: u16) -> FunnelResult<String> {
    let report = check().await;
    if report.state != FunnelState::Ready {
        return Err(Box::new(report));
    }

    if let Err(failure) = run_tailscale(&["funnel", "--bg", &port.to_string()]).await {
        return Err(Box::new(enable_failure_report(&failure).await));
    }
    hostname_from_status().await
}

/// `tailscale funnel` failing *after* a clean [`check`] means either a
/// capability map that didn't tell the whole story (older Tailscale, or a
/// permission revoked seconds ago) or something genuinely unexpected.
/// Either way the CLI's own wording is the best signal left.
async fn enable_failure_report(failure: &CliFailure) -> FunnelReport {
    let err = match failure {
        CliFailure::NotFound(detail) => return not_installed_report(detail),
        CliFailure::Failed(stderr) => stderr.as_str(),
    };
    let lower = err.to_lowercase();
    if lower.contains("https") && (lower.contains("not enabled") || lower.contains("disabled")) {
        return https_not_enabled_report().with_detail(err);
    }
    if lower.contains("funnel") {
        let node_id = status_json().await.ok().and_then(|s| self_node_id(&s));
        return funnel_not_enabled_report(node_id.as_deref()).with_detail(err);
    }
    FunnelReport::new(
        FunnelState::Unknown,
        "Couldn't turn on remote access",
        "Tailscale refused to expose this machine. See the details below.",
    )
    .with_detail(err)
}

/// Turns Funnel off. Keyed by the public HTTPS port (443), not the local
/// port that was being forwarded — confirmed via live testing that this
/// (not the local port) is what `tailscale funnel ... off` expects.
pub async fn disable() -> Result<(), String> {
    run_tailscale(&["funnel", "--https=443", "off"])
        .await
        .map_err(|failure| match failure {
            CliFailure::NotFound(detail) => detail,
            CliFailure::Failed(stderr) => stderr,
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like real `tailscale status --json` output (fields this
    /// module reads, from a live v1.102.3 dump).
    fn status(backend_state: &str, caps: Option<&[&str]>) -> serde_json::Value {
        let mut self_ = serde_json::json!({
            "ID": "niDoQWvXsz11CNTRL",
            "DNSName": "starshell.tail1234.ts.net.",
        });
        if let Some(caps) = caps {
            let map: serde_json::Map<String, serde_json::Value> = caps
                .iter()
                .map(|c| ((*c).to_string(), serde_json::Value::Null))
                .collect();
            self_["CapMap"] = serde_json::Value::Object(map);
        }
        serde_json::json!({ "BackendState": backend_state, "Self": self_ })
    }

    const FUNNEL_CAPS: &[&str] = &[
        "funnel",
        "https",
        "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000",
    ];

    #[test]
    fn a_missing_binary_reads_as_not_installed_with_somewhere_to_go() {
        let report = status_failure_report(&CliFailure::NotFound(
            "tailscale: No such file or directory (os error 2)".to_string(),
        ));
        assert_eq!(report.state, FunnelState::NotInstalled);
        assert!(report.blocks_enabling);
        assert_eq!(report.help_url.as_deref(), Some(INSTALL_URL));
        assert!(report.detail.contains("No such file"));
    }

    #[test]
    fn a_stopped_daemon_is_told_apart_from_a_missing_one() {
        // The wordings the CLI actually uses across platforms/versions.
        for stderr in [
            "failed to connect to local tailscaled; it doesn't appear to be running",
            "Failed to connect to local Tailscaled. Is tailscaled running?",
            "dial unix /var/run/tailscale/tailscaled.sock: connect: connection refused",
        ] {
            let report = status_failure_report(&CliFailure::Failed(stderr.to_string()));
            assert_eq!(
                report.state,
                FunnelState::DaemonNotRunning,
                "not classified: {stderr}"
            );
            assert!(report.command.is_some(), "should say how to start it");
            assert!(report.blocks_enabling);
        }
    }

    /// An unrecognised failure must not masquerade as a diagnosis — it
    /// reports `Unknown` and hands over the CLI's own words.
    #[test]
    fn an_unrecognised_status_failure_keeps_the_raw_output() {
        let report = status_failure_report(&CliFailure::Failed("something novel".to_string()));
        assert_eq!(report.state, FunnelState::Unknown);
        assert_eq!(report.detail, "something novel");
        assert!(!report.blocks_enabling, "an unknown state must not block");
    }

    #[test]
    fn each_unready_backend_state_names_its_own_next_step() {
        for (backend_state, expected) in [
            ("NeedsLogin", FunnelState::NeedsLogin),
            ("NoState", FunnelState::NeedsLogin),
            ("NeedsMachineAuth", FunnelState::NeedsMachineAuth),
            ("Stopped", FunnelState::Stopped),
            ("Starting", FunnelState::Starting),
        ] {
            let report = classify_status(&status(backend_state, Some(FUNNEL_CAPS)));
            assert_eq!(report.state, expected, "for BackendState {backend_state}");
            assert!(!report.title.is_empty() && !report.message.is_empty());
            assert!(
                report.help_url.is_some() || report.command.is_some(),
                "{backend_state} left the user with nothing to do"
            );
        }
    }

    /// "Starting" is a race, not a misconfiguration — blocking the toggle
    /// on it would make a launch-at-login restore look broken.
    #[test]
    fn a_connecting_tailscale_does_not_block_the_toggle() {
        assert!(!FunnelState::Starting.blocks_enabling());
        assert!(!FunnelState::FunnelNotEnabled.blocks_enabling());
        assert!(!FunnelState::Unknown.blocks_enabling());
    }

    /// Startup restore should ride out a cold boot but not sit there
    /// retrying something that will never resolve on its own.
    #[test]
    fn only_boot_race_states_are_worth_retrying_on_startup() {
        for transient in [
            FunnelState::DaemonNotRunning,
            FunnelState::NeedsLogin,
            FunnelState::Starting,
        ] {
            assert!(transient.worth_retrying(), "{transient:?}");
        }
        for settled in [
            FunnelState::NotInstalled,
            FunnelState::NeedsMachineAuth,
            FunnelState::FunnelNotEnabled,
            FunnelState::HttpsNotEnabled,
        ] {
            assert!(!settled.worth_retrying(), "{settled:?}");
        }
    }

    #[test]
    fn a_tailnet_without_funnel_is_caught_before_anything_is_exposed() {
        let report = classify_status(&status("Running", Some(&["https", "ssh"])));
        assert_eq!(report.state, FunnelState::FunnelNotEnabled);
        // Deep-links at this exact node's one-time enable page.
        let url = report.help_url.unwrap();
        assert!(url.contains("login.tailscale.com/f/funnel"), "{url}");
        assert!(url.ends_with("node=niDoQWvXsz11CNTRL"), "{url}");
    }

    #[test]
    fn funnel_allowed_but_https_off_points_at_the_dns_settings() {
        let report = classify_status(&status("Running", Some(&["funnel"])));
        assert_eq!(report.state, FunnelState::HttpsNotEnabled);
        assert_eq!(report.help_url.as_deref(), Some(HTTPS_SETTINGS_URL));
    }

    #[test]
    fn a_fully_set_up_machine_reports_ready() {
        let report = classify_status(&status("Running", Some(FUNNEL_CAPS)));
        assert_eq!(report.state, FunnelState::Ready);
        assert!(!report.blocks_enabling);
    }

    /// Capability reporting is the one input that could change shape in a
    /// future Tailscale. Absent it, `check` must assume the best and let
    /// the real enable attempt be the judge — never report a working
    /// tailnet as unauthorized.
    #[test]
    fn absent_capability_reporting_never_invents_a_permission_problem() {
        let report = classify_status(&status("Running", None));
        assert_eq!(report.state, FunnelState::Ready);
    }

    #[test]
    fn the_deprecated_flat_capability_list_is_still_understood() {
        let mut value = status("Running", None);
        value["Self"]["Capabilities"] = serde_json::json!(["funnel", "https"]);
        assert_eq!(classify_status(&value).state, FunnelState::Ready);

        let mut value = status("Running", None);
        value["Self"]["Capabilities"] = serde_json::json!(["ssh"]);
        assert_eq!(classify_status(&value).state, FunnelState::FunnelNotEnabled);
    }

    /// Guards the one assumption this module makes about a CLI it doesn't
    /// own: that `Self.CapMap` is where Funnel permission shows up.
    /// Ignored by default — it needs a real, logged-in Tailscale.
    #[tokio::test]
    #[ignore = "requires a logged-in Tailscale install"]
    async fn live_status_still_carries_the_fields_this_module_reads() {
        let status = status_json().await.expect("tailscale status --json");
        assert_eq!(
            status.get("BackendState").and_then(|v| v.as_str()),
            Some("Running")
        );
        assert!(self_node_id(&status).is_some(), "Self.ID went missing");
        let caps = granted_capabilities(&status).expect("Self.CapMap/Capabilities went missing");
        assert!(
            caps.iter().any(|c| c == "funnel"),
            "no `funnel` capability on a tailnet that has Funnel enabled: {caps:?}"
        );
    }
}
