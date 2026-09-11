//! Shells out to the `tailscale` CLI to expose the relay's local port
//! publicly over Tailscale Funnel, and to discover the public hostname
//! Funnel serves it on. Mirrors `git.rs::run_git`'s shell-out shape
//! (`tokio::process::Command` + `.hide_window()` + status/stderr check),
//! the established convention in this codebase for invoking an external
//! CLI.
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
//! - Funnel additionally requires a one-time enable at the tailnet/account
//!   level (separate from being logged in at all) via
//!   `https://login.tailscale.com/f/funnel?node=<NodeID>` — surfaced below
//!   as a hint appended to whatever `tailscale funnel` itself reports,
//!   rather than matched against exact CLI wording that could change
//!   across versions.

use crate::process_ext::{resolve_executable, HiddenCommandExt};
use tokio::process::Command;

async fn run_tailscale(args: &[&str]) -> Result<String, String> {
    let exe = resolve_executable("tailscale");
    let output = Command::new(&exe)
        .args(args)
        .hide_window()
        .output()
        .await
        .map_err(|e| {
            format!(
                "Tailscale CLI not found (looked for \"{}\"): {e}. Install Tailscale \
                 and make sure it's on your PATH, then try again.",
                exe.display()
            )
        })?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn status_json() -> Result<serde_json::Value, String> {
    let raw = run_tailscale(&["status", "--json"]).await?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse `tailscale status --json`: {e}"))
}

/// This node's MagicDNS hostname, trailing dot stripped (`tailscale
/// status --json`'s `Self.DNSName` is fully-qualified, e.g.
/// `"my-laptop.tailxxxx.ts.net."`).
async fn hostname_from_status() -> Result<String, String> {
    let status = status_json().await?;
    let dns_name = status
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "`tailscale status` did not report a hostname for this device".to_string()
        })?;
    Ok(dns_name.trim_end_matches('.').to_string())
}

async fn self_node_id() -> Result<String, String> {
    let status = status_json().await?;
    status
        .get("Self")
        .and_then(|s| s.get("ID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "`tailscale status` did not report this device's node ID".to_string())
}

/// Checked before every enable attempt so the Settings toggle fails with a
/// specific, actionable message ("not installed" vs "not logged in")
/// instead of a raw `tailscale funnel` error.
async fn preflight() -> Result<(), String> {
    let status = status_json().await?;
    let backend_state = status
        .get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if backend_state != "Running" {
        return Err(format!(
            "Tailscale is installed but not logged in (state: {backend_state}). \
             Open the Tailscale app (or run `tailscale up`) to log in, then try again."
        ));
    }
    Ok(())
}

/// Turns Funnel on for `port` and returns the public hostname it's now
/// reachable on. On failure that looks Funnel-related, appends the
/// account-level enable URL as a hint — Funnel needing a separate opt-in
/// per tailnet is a real, easy-to-hit failure mode distinct from "not
/// installed"/"not logged in", both already ruled out by `preflight`.
pub async fn enable(port: u16) -> Result<String, String> {
    preflight().await?;
    if let Err(err) = run_tailscale(&["funnel", "--bg", &port.to_string()]).await {
        let looks_funnel_related = err.to_lowercase().contains("funnel") && !err.contains("http");
        if looks_funnel_related {
            if let Ok(node_id) = self_node_id().await {
                return Err(format!(
                    "{err}\n\nFunnel may not be enabled for your tailnet yet. Visit \
                     https://login.tailscale.com/f/funnel?node={node_id} to enable it, \
                     then try again."
                ));
            }
        }
        return Err(err);
    }
    hostname_from_status().await
}

/// Turns Funnel off. Keyed by the public HTTPS port (443), not the local
/// port that was being forwarded — confirmed via live testing that this
/// (not the local port) is what `tailscale funnel ... off` expects.
pub async fn disable() -> Result<(), String> {
    run_tailscale(&["funnel", "--https=443", "off"]).await?;
    Ok(())
}
