use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;

/// The three CLIs Maestro knows how to wrap. Detection/auth-state is
/// centralized here so it can be reused by every feature that needs to
/// know "is an agent CLI available right now" — not just the agent tabs
/// (see `commands/agents.rs::generate_commit_message`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    CursorAgent,
}

impl AgentKind {
    pub fn all() -> [AgentKind; 3] {
        [
            AgentKind::ClaudeCode,
            AgentKind::Codex,
            AgentKind::CursorAgent,
        ]
    }

    /// Default binary name, resolved via PATH unless overridden in
    /// `settings` (see `resolve_binary_path`).
    pub fn default_binary(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude",
            AgentKind::Codex => "codex",
            AgentKind::CursorAgent => "cursor-agent",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::Codex => "Codex CLI",
            AgentKind::CursorAgent => "Cursor Agent",
        }
    }

    /// Stable key for the `settings` table (`agent.<slug>.binary_path`).
    pub fn slug(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::Codex => "codex",
            AgentKind::CursorAgent => "cursor-agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthState {
    /// Installed, but auth couldn't be positively confirmed or denied
    /// (e.g. a CLI's status subcommand returns an unfamiliar shape).
    /// Never used to imply "assume it works".
    Unknown,
    Authenticated,
    NotAuthenticated,
    /// The auth-status check itself failed to run (distinct from
    /// `NotAuthenticated`, which means it ran and reported logged-out).
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub kind: AgentKind,
    pub installed: bool,
    pub version: Option<String>,
    pub binary_path: String,
    pub auth_state: AuthState,
    /// Human-readable detail — wherever possible this is the CLI's own
    /// output (e.g. its login instructions), not Maestro-authored copy,
    /// per docs/CHECKLIST.md's "actionable message... not a silent
    /// failure" requirement.
    pub auth_detail: Option<String>,
    pub checked_at: String,
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

async fn run_with_timeout(mut command: Command) -> Result<std::process::Output, std::io::Error> {
    match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out",
        )),
    }
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Full detection pass for one CLI: binary presence + version (fast,
/// reliable, no network) followed by a real local auth-status check where
/// one is known (also fast/local/free — see docs/CHECKLIST.md and the
/// plan's Step 0 findings). Never fabricates an "authenticated" result —
/// unverifiable states are reported as `Unknown` with an explanatory
/// detail rather than guessed.
pub async fn detect(kind: AgentKind, binary_override: Option<String>) -> CliStatus {
    let binary_path = binary_override.unwrap_or_else(|| kind.default_binary().to_string());
    let checked_at = chrono::Utc::now().to_rfc3339();

    let mut version_cmd = Command::new(&binary_path);
    version_cmd.arg("--version");
    let version_output = run_with_timeout(version_cmd).await;

    let (installed, version) = match version_output {
        Ok(out) if out.status.success() => (true, Some(first_line(&out.stdout))),
        Ok(_) => (true, None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None),
        Err(_) => (false, None),
    };

    if !installed {
        return CliStatus {
            kind,
            installed,
            version,
            binary_path: binary_path.clone(),
            auth_state: AuthState::Unknown,
            auth_detail: Some(format!("`{binary_path}` was not found on PATH.")),
            checked_at,
        };
    }

    let (auth_state, auth_detail) = probe_auth(kind, &binary_path).await;
    CliStatus {
        kind,
        installed,
        version,
        binary_path,
        auth_state,
        auth_detail,
        checked_at,
    }
}

async fn probe_auth(kind: AgentKind, binary_path: &str) -> (AuthState, Option<String>) {
    match kind {
        AgentKind::ClaudeCode => {
            let mut cmd = Command::new(binary_path);
            cmd.args(["auth", "status", "--json"]);
            probe_json_auth(cmd, |v| {
                let logged_in = v.get("loggedIn").and_then(|b| b.as_bool()).unwrap_or(false);
                if logged_in {
                    let email = v.get("email").and_then(|e| e.as_str()).unwrap_or("");
                    (
                        AuthState::Authenticated,
                        Some(format!("Signed in as {email}")),
                    )
                } else {
                    (
                        AuthState::NotAuthenticated,
                        Some("Run `claude auth login` to sign in.".to_string()),
                    )
                }
            })
            .await
        }
        AgentKind::CursorAgent => {
            let mut cmd = Command::new(binary_path);
            cmd.args(["status", "--format", "json"]);
            probe_json_auth(cmd, |v| {
                let authed = v
                    .get("isAuthenticated")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                if authed {
                    let email = v
                        .get("userInfo")
                        .and_then(|u| u.get("email"))
                        .and_then(|e| e.as_str())
                        .unwrap_or("");
                    (
                        AuthState::Authenticated,
                        Some(format!("Signed in as {email}")),
                    )
                } else {
                    (
                        AuthState::NotAuthenticated,
                        Some("Run `cursor-agent login` to sign in.".to_string()),
                    )
                }
            })
            .await
        }
        AgentKind::Codex => {
            // Live-verified with standalone Codex CLI 0.147.0.
            let mut cmd = Command::new(binary_path);
            cmd.args(["login", "status"]);
            match run_with_timeout(cmd).await {
                Ok(out) if out.status.success() => (
                    AuthState::Authenticated,
                    Some(first_line(&out.stdout)).filter(|s| !s.is_empty()),
                ),
                Ok(out) => {
                    let stderr = first_line(&out.stderr);
                    let detail = if stderr.is_empty() {
                        "Could not verify Codex auth status — unverified for this build."
                            .to_string()
                    } else {
                        stderr
                    };
                    (AuthState::Unknown, Some(detail))
                }
                Err(e) => (
                    AuthState::Unknown,
                    Some(format!("Could not run Codex auth check: {e}")),
                ),
            }
        }
    }
}

async fn probe_json_auth(
    command: Command,
    classify: impl FnOnce(&serde_json::Value) -> (AuthState, Option<String>),
) -> (AuthState, Option<String>) {
    match run_with_timeout(command).await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<serde_json::Value>(&stdout) {
                Ok(value) => classify(&value),
                Err(_) => {
                    let stderr = first_line(&out.stderr);
                    (
                        AuthState::Error,
                        Some(if stderr.is_empty() {
                            "Auth status check returned unexpected output.".to_string()
                        } else {
                            stderr
                        }),
                    )
                }
            }
        }
        Err(e) => (
            AuthState::Error,
            Some(format!("Auth status check failed: {e}")),
        ),
    }
}
