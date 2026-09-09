//! Local MCP tool server (docs V2 "worktree-aware agents" plan) — gives an
//! agent turn visibility into, and limited control over, the *other* tabs
//! (terminal tabs, sibling agent tabs) open in the same worktree, which it
//! otherwise has no way to see: each CLI only knows about its own Bash tool
//! inside its own spawn.
//!
//! Runs once per app launch (`spawn_mcp_server`, called from `lib.rs::run`),
//! bound to an ephemeral `127.0.0.1` port — same loopback-only, unauthenticated
//! trust boundary as the existing opencode sidecar (`agents/opencode/sidecar.rs`).
//! Every adapter (`claude.rs`, `codex.rs`, `cursor_agent.rs`) points its CLI
//! at this one server; only the *how do I tell the CLI about it* wiring
//! differs per adapter, same split `adapter.rs` already keeps for everything
//! else CLI-specific.
//!
//! Tools operate directly on `AppState.terminals` / `AppState.agent_runs` —
//! the exact same bookkeeping `processes.rs` already reads for the Process
//! Manager UI — rather than a second data model. All four tools take a
//! `worktree_path` argument matched against those structs' own worktree
//! fields; it's a pure in-memory lookup (no filesystem access), and every
//! adapter already spawns its CLI with that exact path as its cwd, so the
//! model can supply it from its own context.

use crate::processes::{list_managed_processes, ManagedProcess, ManagedProcessKind};
use crate::state::AppState;
use crate::terminal::write_to_terminal;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, Implementation, ProtocolVersion, ServerCapabilities,
        ServerInfo,
    },
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use tauri::{AppHandle, Manager};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct WorktreeOnlyRequest {
    #[schemars(
        description = "Absolute path to the git worktree root you are running in — your own current working directory."
    )]
    pub worktree_path: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ReadTerminalRequest {
    #[schemars(
        description = "Absolute path to the git worktree root you are running in — your own current working directory."
    )]
    pub worktree_path: String,
    #[schemars(description = "A terminal id from list_terminals.")]
    pub terminal_id: String,
    #[schemars(
        description = "Maximum number of bytes of output to return, most recent first. Defaults to 8000."
    )]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SendTerminalInputRequest {
    #[schemars(
        description = "Absolute path to the git worktree root you are running in — your own current working directory."
    )]
    pub worktree_path: String,
    #[schemars(description = "A terminal id from list_terminals.")]
    pub terminal_id: String,
    #[schemars(
        description = "Text to type into the terminal. Enter is pressed automatically after it."
    )]
    pub text: String,
}

const DEFAULT_READ_BYTES: usize = 8000;

#[derive(Clone)]
pub struct MaestroTools {
    app: AppHandle,
    tool_router: ToolRouter<MaestroTools>,
}

impl MaestroTools {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }

    /// Every `ManagedProcess` (`processes.rs`) belonging to `worktree_path` —
    /// the same agent+terminal+LSP+hook rollup the Process Manager UI shows,
    /// reused rather than re-derived, minus its CPU/memory sampling (not
    /// useful to a model and not worth the extra `sysinfo` pass here).
    async fn processes_in(&self, worktree_path: &str) -> Result<Vec<ManagedProcess>, McpError> {
        let snapshot = list_managed_processes(self.app.state::<AppState>())
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        Ok(snapshot
            .processes
            .into_iter()
            .filter(|p| p.worktree_root.as_deref() == Some(worktree_path))
            .collect())
    }
}

#[tool_router]
impl MaestroTools {
    #[tool(
        description = "List the terminal tabs currently open in this worktree inside Maestro (the GUI wrapping this CLI) — e.g. one running a dev server. Use this before read_terminal_output or send_terminal_input to find a terminal_id."
    )]
    async fn list_terminals(
        &self,
        Parameters(WorktreeOnlyRequest { worktree_path }): Parameters<WorktreeOnlyRequest>,
    ) -> Result<CallToolResult, McpError> {
        let terminals: Vec<String> = self
            .processes_in(&worktree_path)
            .await?
            .into_iter()
            .filter(|p| p.kind == ManagedProcessKind::Terminal)
            .map(|p| {
                format!(
                    "{} — {}{}",
                    p.id,
                    p.label,
                    p.detail.map(|d| format!(" ({d})")).unwrap_or_default()
                )
            })
            .collect();
        let text = if terminals.is_empty() {
            format!("No terminal tabs are open in {worktree_path}.")
        } else {
            terminals.join("\n")
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }

    #[tool(
        description = "List every Maestro-managed process running in this worktree — terminal tabs and sibling agent tabs, with their status. Use this to check whether a dev server or another agent is currently running before, e.g., restarting it."
    )]
    async fn list_processes(
        &self,
        Parameters(WorktreeOnlyRequest { worktree_path }): Parameters<WorktreeOnlyRequest>,
    ) -> Result<CallToolResult, McpError> {
        let processes = self.processes_in(&worktree_path).await?;
        let text = if processes.is_empty() {
            format!("No Maestro-managed processes are running in {worktree_path}.")
        } else {
            processes
                .into_iter()
                .map(|p| {
                    format!(
                        "[{:?}] {} — {} ({:?}){}",
                        p.kind,
                        p.id,
                        p.label,
                        p.status,
                        p.detail.map(|d| format!(" — {d}")).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }

    #[tool(
        description = "Read the most recent output from a terminal tab in this worktree — e.g. a dev server's log lines. Get terminal_id from list_terminals first."
    )]
    async fn read_terminal_output(
        &self,
        Parameters(ReadTerminalRequest {
            worktree_path,
            terminal_id,
            max_bytes,
        }): Parameters<ReadTerminalRequest>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.app.state::<AppState>();
        let terminals = state
            .terminals
            .lock()
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let handle = terminals.get(&terminal_id).ok_or_else(|| {
            McpError::invalid_params(
                format!("No terminal with id '{terminal_id}' is open."),
                None,
            )
        })?;
        if handle.worktree_path != worktree_path {
            return Err(McpError::invalid_params(
                format!("Terminal '{terminal_id}' does not belong to worktree '{worktree_path}'."),
                None,
            ));
        }
        let text = handle.tail(max_bytes.unwrap_or(DEFAULT_READ_BYTES));
        let text = if text.is_empty() {
            "(no output yet)".to_string()
        } else {
            text
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }

    #[tool(
        description = "Type text into a running terminal tab in this worktree and press Enter — e.g. to restart a dev server or run a command. Get terminal_id from list_terminals first. Only use this on a terminal a person would recognize; it types exactly as given."
    )]
    async fn send_terminal_input(
        &self,
        Parameters(SendTerminalInputRequest {
            worktree_path,
            terminal_id,
            text,
        }): Parameters<SendTerminalInputRequest>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.app.state::<AppState>();
        {
            let terminals = state
                .terminals
                .lock()
                .map_err(|e| McpError::internal_error(e.to_string(), None))?;
            let handle = terminals.get(&terminal_id).ok_or_else(|| {
                McpError::invalid_params(
                    format!("No terminal with id '{terminal_id}' is open."),
                    None,
                )
            })?;
            if handle.worktree_path != worktree_path {
                return Err(McpError::invalid_params(
                    format!(
                        "Terminal '{terminal_id}' does not belong to worktree '{worktree_path}'."
                    ),
                    None,
                ));
            }
        }
        let mut payload = text;
        payload.push('\n');
        write_to_terminal(&state, &terminal_id, &payload)
            .map_err(|e| McpError::internal_error(e, None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "Sent to terminal '{terminal_id}'."
        ))]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MaestroTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(
                "Tools for seeing and controlling terminal tabs and sibling agent tabs open in \
                 the SAME worktree inside Maestro, the GUI wrapping this CLI. Always pass \
                 worktree_path as your own current working directory."
                    .to_string(),
            )
    }
}

/// Binds the server to an ephemeral loopback port and starts serving in the
/// background. Called once from `lib.rs::run`'s `setup` hook, before any
/// agent turn can spawn — `manager.rs::run_turn` reads the returned port
/// back off `AppState::mcp_server_port`.
pub async fn spawn_mcp_server(app: AppHandle) -> Result<u16, String> {
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("failed to bind the local MCP tool server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let service = StreamableHttpService::new(
        move || Ok(MaestroTools::new(app.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    Ok(port)
}
