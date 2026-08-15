use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: usize = 4096;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const CONTROL_QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspServerKind {
    TypeScript,
    RustAnalyzer,
    Pyright,
    Gopls,
}

impl LspServerKind {
    pub fn all() -> [Self; 4] {
        [
            Self::TypeScript,
            Self::RustAnalyzer,
            Self::Pyright,
            Self::Gopls,
        ]
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::RustAnalyzer => "rust-analyzer",
            Self::Pyright => "pyright",
            Self::Gopls => "gopls",
        }
    }

    /// Inverse of `slug` — the Process Manager encodes a running server's
    /// identity as `worktreeId:slug` (`processes.rs`), so a kill request
    /// coming back from the frontend has to decode to the same kind.
    pub fn from_slug(slug: &str) -> Option<Self> {
        Self::all().into_iter().find(|kind| kind.slug() == slug)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::TypeScript => "TypeScript / JavaScript",
            Self::RustAnalyzer => "Rust",
            Self::Pyright => "Python",
            Self::Gopls => "Go",
        }
    }

    pub fn default_binary(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript-language-server",
            Self::RustAnalyzer => "rust-analyzer",
            Self::Pyright => "pyright-langserver",
            Self::Gopls => "gopls",
        }
    }

    fn version_args(self) -> &'static [&'static str] {
        match self {
            Self::TypeScript | Self::Pyright => &["--version"],
            Self::RustAnalyzer => &["--version"],
            Self::Gopls => &["version"],
        }
    }

    pub fn server_args(self) -> &'static [&'static str] {
        match self {
            Self::TypeScript | Self::Pyright => &["--stdio"],
            Self::RustAnalyzer | Self::Gopls => &[],
        }
    }

    pub fn install_hint(self) -> &'static str {
        match self {
            Self::TypeScript => "npm install -g typescript-language-server typescript@5",
            Self::RustAnalyzer => "rustup component add rust-analyzer rust-src",
            Self::Pyright => "npm install -g pyright",
            Self::Gopls => "go install golang.org/x/tools/gopls@latest",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspAvailability {
    Ready,
    Missing,
    NotExecutable,
    TimedOut,
    ProbeFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub kind: LspServerKind,
    pub display_name: String,
    pub availability: LspAvailability,
    pub binary_path: String,
    pub server_args: Vec<String>,
    pub version: Option<String>,
    pub detail: Option<String>,
    pub install_hint: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspProcessKey {
    pub worktree_id: String,
    pub kind: LspServerKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningLspServer {
    pub key: LspProcessKey,
    pub generation: String,
    pub pid: Option<u32>,
    pub type_script_sdk: Option<TypeScriptSdk>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeScriptSdk {
    pub path: String,
    pub version: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspTransportEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        generation: String,
        pid: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Message { message: String },
    #[serde(rename_all = "camelCase")]
    Stderr { line: String },
    #[serde(rename_all = "camelCase")]
    ProtocolError { message: String, fatal: bool },
    #[serde(rename_all = "camelCase")]
    Exited {
        code: Option<i32>,
        requested: bool,
        detail: Option<String>,
    },
}

#[derive(Debug)]
pub enum LspControlMessage {
    Send(String),
    Stop,
}

#[derive(Clone)]
pub struct LspServerEntry {
    pub generation: String,
    pub pid: Option<u32>,
    pub control_tx: mpsc::Sender<LspControlMessage>,
    /// Reporting-only fields, for the Process Manager (`processes.rs`) —
    /// the transport itself never reads them. Recorded at spawn because
    /// that is the only moment the root path and resolved binary are in
    /// scope; re-deriving them later would mean re-reading settings.
    pub worktree_root: String,
    pub binary_path: String,
    pub started_at_ms: u64,
}

enum ReaderEvent {
    Message(String),
    Fatal(String),
}

/// Reads one LSP `Content-Length` frame. Header and body limits are enforced
/// before allocation so a buggy/hostile server cannot exhaust the app.
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            if header_bytes == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "EOF inside LSP header",
            ));
        }
        header_bytes += read;
        if header_bytes > MAX_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "LSP header exceeds limit",
            ));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.trim_end_matches(['\r', '\n']).split_once(':') else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed LSP header",
            ));
        };
        if name.eq_ignore_ascii_case("Content-Length") {
            if content_length.is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "duplicate Content-Length",
                ));
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid Content-Length")
            })?);
        }
    }
    let len = content_length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
    if len > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "LSP message exceeds limit",
        ));
    }
    let mut body = vec![0u8; len];
    tokio::io::AsyncReadExt::read_exact(reader, &mut body).await?;
    let message = String::from_utf8(body)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "LSP message is not UTF-8"))?;
    serde_json::from_str::<serde_json::Value>(&message)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "LSP message is not valid JSON"))?;
    Ok(Some(message))
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, message: &str) -> io::Result<()> {
    validate_outbound_message(message)?;
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes())
        .await?;
    writer.write_all(message.as_bytes()).await?;
    writer.flush().await
}

pub fn validate_outbound_message(message: &str) -> io::Result<()> {
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "LSP message exceeds limit",
        ));
    }
    let value = serde_json::from_str::<serde_json::Value>(message).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "LSP message is not valid JSON")
    })?;
    if !value.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "LSP message must be a JSON object",
        ));
    }
    Ok(())
}

pub async fn spawn_server(
    app: AppHandle,
    key: LspProcessKey,
    worktree_root: &Path,
    binary_path: &str,
    args: &[String],
    on_event: Channel<LspTransportEvent>,
) -> Result<LspServerEntry, String> {
    let mut command = Command::new(binary_path);
    command
        .args(args)
        .current_dir(worktree_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {binary_path}: {error}"))?;
    let pid = child.id();
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Language server stdin was not captured")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Language server stdout was not captured")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Language server stderr was not captured")?;
    let generation = uuid::Uuid::new_v4().to_string();
    let (control_tx, mut control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    let entry = LspServerEntry {
        generation: generation.clone(),
        pid,
        control_tx,
        worktree_root: worktree_root.to_string_lossy().to_string(),
        binary_path: binary_path.to_string(),
        started_at_ms: crate::processes::now_ms(),
    };
    {
        let state = app.state::<crate::state::AppState>();
        let mut servers = state
            .lsp_servers
            .lock()
            .map_err(|error| error.to_string())?;
        if servers.contains_key(&key) {
            let _ = child.start_kill();
            return Err(format!(
                "{} is already running for this worktree.",
                key.kind.display_name()
            ));
        }
        servers.insert(key.clone(), entry.clone());
    }
    let (reader_tx, mut reader_rx) = mpsc::channel::<ReaderEvent>(32);
    let (stderr_tx, mut stderr_rx) = mpsc::channel::<String>(32);

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader).await {
                Ok(Some(message)) => {
                    if reader_tx.send(ReaderEvent::Message(message)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = reader_tx.send(ReaderEvent::Fatal(error.to_string())).await;
                    break;
                }
            }
        }
    });

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let bounded: String = line.chars().take(MAX_OUTPUT_BYTES).collect();
            if stderr_tx.send(bounded).await.is_err() {
                break;
            }
        }
    });

    let task_generation = generation.clone();
    let task_key = key.clone();
    tokio::spawn(async move {
        let mut requested = false;
        let mut terminal_detail = None;
        if on_event
            .send(LspTransportEvent::Started {
                generation: task_generation.clone(),
                pid,
            })
            .is_err()
        {
            requested = true;
            terminal_detail = Some("LSP client disconnected during startup.".to_string());
            let _ = child.start_kill();
        }
        let exit_status = loop {
            tokio::select! {
                status = child.wait() => break status.ok(),
                control = control_rx.recv() => match control {
                    Some(LspControlMessage::Send(message)) => {
                        if let Err(error) = write_frame(&mut stdin, &message).await {
                            terminal_detail = Some(format!("Failed writing to language server: {error}"));
                            let _ = child.start_kill();
                        }
                    }
                    Some(LspControlMessage::Stop) | None => {
                        requested = true;
                        let _ = child.start_kill();
                    }
                },
                reader_event = reader_rx.recv() => match reader_event {
                    Some(ReaderEvent::Message(message)) => {
                        if on_event.send(LspTransportEvent::Message { message }).is_err() {
                            requested = true;
                            let _ = child.start_kill();
                        }
                    }
                    Some(ReaderEvent::Fatal(message)) => {
                        terminal_detail = Some(message.clone());
                        let _ = on_event.send(LspTransportEvent::ProtocolError { message, fatal: true });
                        let _ = child.start_kill();
                    }
                    None => {}
                },
                line = stderr_rx.recv() => {
                    if let Some(line) = line {
                        let _ = on_event.send(LspTransportEvent::Stderr { line });
                    }
                }
            }
        };
        let code = exit_status.and_then(|status| status.code());
        let _ = on_event.send(LspTransportEvent::Exited {
            code,
            requested,
            detail: terminal_detail,
        });

        let state = app.state::<crate::state::AppState>();
        if let Ok(mut servers) = state.lsp_servers.lock() {
            let should_remove = servers
                .get(&task_key)
                .map(|entry| entry.generation == task_generation)
                .unwrap_or(false);
            if should_remove {
                servers.remove(&task_key);
            }
        };
    });

    Ok(entry)
}

pub fn kill_all(state: &crate::state::AppState) {
    if let Ok(mut servers) = state.lsp_servers.lock() {
        for (_, entry) in servers.drain() {
            let _ = entry.control_tx.try_send(LspControlMessage::Stop);
        }
    }
}

fn bounded_first_line(bytes: &[u8]) -> Option<String> {
    let bounded = &bytes[..bytes.len().min(MAX_OUTPUT_BYTES)];
    let line = String::from_utf8_lossy(bounded)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    (!line.is_empty()).then_some(line)
}

fn executable_path(binary_path: &str) -> Option<PathBuf> {
    let requested = Path::new(binary_path);
    if requested.components().count() > 1 {
        return requested.canonicalize().ok();
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(binary_path))
            .find(|candidate| candidate.is_file())
            .and_then(|candidate| candidate.canonicalize().ok())
    })
}

fn package_version(package_root: &Path) -> Option<String> {
    let bytes = std::fs::read(package_root.join("package.json")).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn sdk_from_package(package_root: &Path, source: &str) -> Option<TypeScriptSdk> {
    let path = package_root.join("lib").join("tsserver.js");
    path.is_file().then(|| TypeScriptSdk {
        path: path.to_string_lossy().into_owned(),
        version: package_version(package_root),
        source: source.to_string(),
    })
}

/// Resolves the TypeScript runtime separately from the LSP wrapper. A
/// successful `typescript-language-server --version` probe is insufficient:
/// the wrapper exits during initialize when neither the worktree nor its own
/// installation contains a classic `lib/tsserver.js` SDK.
pub fn resolve_typescript_sdk(
    worktree_root: &Path,
    language_server_binary: &str,
    configured_path: Option<&str>,
) -> Result<TypeScriptSdk, String> {
    if let Some(configured) = configured_path.filter(|value| !value.trim().is_empty()) {
        let requested = PathBuf::from(configured);
        let (path, package_root) = if requested.is_file()
            && requested.file_name().and_then(|name| name.to_str()) == Some("tsserver.js")
        {
            let package_root = requested
                .parent()
                .and_then(Path::parent)
                .unwrap_or(worktree_root)
                .to_path_buf();
            (requested, package_root)
        } else if requested.join("tsserver.js").is_file() {
            let package_root = requested.parent().unwrap_or(&requested).to_path_buf();
            (requested.join("tsserver.js"), package_root)
        } else if let Some(sdk) = sdk_from_package(&requested, "user-setting") {
            return Ok(sdk);
        } else {
            return Err(format!(
                "The configured TypeScript SDK `{configured}` is invalid. Select a TypeScript package directory, its `lib` directory, or `lib/tsserver.js`, then use Recheck."
            ));
        };
        return Ok(TypeScriptSdk {
            path: path.to_string_lossy().into_owned(),
            version: package_version(&package_root),
            source: "user-setting".to_string(),
        });
    }

    let workspace_candidates = [
        worktree_root.join("node_modules/typescript"),
        worktree_root.join(".yarn/sdks/typescript"),
        worktree_root.join(".vscode/pnpify/typescript"),
    ];
    for package_root in &workspace_candidates {
        if let Some(sdk) = sdk_from_package(package_root, "workspace") {
            return Ok(sdk);
        }
    }

    let mut bundled_candidates = Vec::new();
    if let Some(executable) = executable_path(language_server_binary) {
        // npm/pnpm global layout: <node_modules>/typescript-language-server/...
        // Prefer a dependency nested in the wrapper, then a global sibling.
        if let Some(package_root) = executable.ancestors().find(|ancestor| {
            ancestor.file_name().and_then(|name| name.to_str())
                == Some("typescript-language-server")
        }) {
            bundled_candidates.push(package_root.join("node_modules/typescript"));
            if let Some(node_modules) = package_root.parent() {
                bundled_candidates.push(node_modules.join("typescript"));
            }
        }
    }
    for package_root in &bundled_candidates {
        if let Some(sdk) = sdk_from_package(package_root, "language-server-installation") {
            return Ok(sdk);
        }
    }

    let incompatible = workspace_candidates
        .iter()
        .chain(bundled_candidates.iter())
        .filter(|root| root.join("package.json").is_file())
        .map(|root| {
            let version = package_version(root).unwrap_or_else(|| "unknown version".to_string());
            format!("{} ({version})", root.display())
        })
        .collect::<Vec<_>>();
    let inspected = if incompatible.is_empty() {
        "No TypeScript package was found in the worktree or beside the language server.".to_string()
    } else {
        format!(
            "These TypeScript packages do not provide lib/tsserver.js: {}.",
            incompatible.join(", ")
        )
    };
    Err(format!(
        "TypeScript language intelligence needs a compatible TypeScript SDK. {inspected} Install a stable SDK in the project (`npm install --save-dev typescript`) or globally beside the server (`npm install -g typescript-language-server typescript@5`). Then use Recheck; Maestro does not need to restart."
    ))
}

pub async fn detect(kind: LspServerKind, binary_override: Option<String>) -> LspServerStatus {
    let binary_path = binary_override.unwrap_or_else(|| kind.default_binary().to_string());
    let checked_at = chrono::Utc::now().to_rfc3339();
    let mut command = Command::new(&binary_path);
    command
        .args(kind.version_args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let result = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await;
    let (availability, version, detail) = match result {
        Err(_) => (
            LspAvailability::TimedOut,
            None,
            Some(format!(
                "Version probe timed out after {} seconds.",
                PROBE_TIMEOUT.as_secs()
            )),
        ),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => (
            LspAvailability::Missing,
            None,
            Some(format!("`{binary_path}` was not found on Maestro's PATH.")),
        ),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::PermissionDenied => (
            LspAvailability::NotExecutable,
            None,
            Some(format!("`{binary_path}` is not executable: {error}")),
        ),
        Ok(Err(error)) => (LspAvailability::ProbeFailed, None, Some(error.to_string())),
        Ok(Ok(output)) if output.status.success() => {
            let version =
                bounded_first_line(&output.stdout).or_else(|| bounded_first_line(&output.stderr));
            (LspAvailability::Ready, version, None)
        }
        Ok(Ok(output)) => {
            let detail = bounded_first_line(&output.stderr)
                .or_else(|| bounded_first_line(&output.stdout))
                .unwrap_or_else(|| format!("Version probe exited with {}.", output.status));
            (LspAvailability::ProbeFailed, None, Some(detail))
        }
    };

    LspServerStatus {
        kind,
        display_name: kind.display_name().to_string(),
        availability,
        binary_path,
        server_args: kind
            .server_args()
            .iter()
            .map(|arg| (*arg).to_string())
            .collect(),
        version,
        detail,
        install_hint: kind.install_hint().to_string(),
        checked_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn missing_binary_is_classified_without_panicking() {
        let status = detect(
            LspServerKind::Gopls,
            Some("maestro-definitely-missing-lsp-binary".to_string()),
        )
        .await;
        assert_eq!(status.availability, LspAvailability::Missing);
        assert!(status.detail.unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn successful_override_records_version() {
        let status = detect(LspServerKind::RustAnalyzer, Some("rustc".to_string())).await;
        assert_eq!(status.availability, LspAvailability::Ready);
        assert!(status.version.is_some());
    }

    #[test]
    fn typescript_sdk_prefers_a_compatible_workspace_installation() {
        let worktree = tempfile::tempdir().unwrap();
        let package_root = worktree.path().join("node_modules/typescript");
        std::fs::create_dir_all(package_root.join("lib")).unwrap();
        std::fs::write(package_root.join("lib/tsserver.js"), "").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"typescript","version":"5.9.3"}"#,
        )
        .unwrap();
        let sdk = resolve_typescript_sdk(worktree.path(), "missing-wrapper", None).unwrap();
        assert_eq!(sdk.source, "workspace");
        assert_eq!(sdk.version.as_deref(), Some("5.9.3"));
        assert!(sdk.path.ends_with("lib/tsserver.js"));
    }

    #[test]
    fn typescript_sdk_rejects_new_packages_without_tsserver() {
        let worktree = tempfile::tempdir().unwrap();
        let package_root = worktree.path().join("node_modules/typescript");
        std::fs::create_dir_all(&package_root).unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@typescript/typescript6","version":"6.0.2"}"#,
        )
        .unwrap();
        let error = resolve_typescript_sdk(worktree.path(), "missing-wrapper", None).unwrap_err();
        assert!(error.contains("6.0.2"));
        assert!(error.contains("do not provide lib/tsserver.js"));
        assert!(error.contains("Recheck"));
    }

    #[test]
    fn configured_typescript_sdk_accepts_package_lib_or_server_file() {
        let worktree = tempfile::tempdir().unwrap();
        let package_root = worktree.path().join("sdk");
        std::fs::create_dir_all(package_root.join("lib")).unwrap();
        std::fs::write(package_root.join("lib/tsserver.js"), "").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"typescript","version":"5.8.3"}"#,
        )
        .unwrap();
        for configured in [
            package_root.clone(),
            package_root.join("lib"),
            package_root.join("lib/tsserver.js"),
        ] {
            let sdk = resolve_typescript_sdk(
                worktree.path(),
                "missing-wrapper",
                Some(&configured.to_string_lossy()),
            )
            .unwrap();
            assert_eq!(sdk.source, "user-setting");
            assert!(sdk.path.ends_with("lib/tsserver.js"));
        }
    }

    #[tokio::test]
    async fn frame_reader_handles_split_writes_and_unicode_lengths() {
        let (mut writer, reader) = tokio::io::duplex(256);
        let body = r#"{"jsonrpc":"2.0","method":"x","params":"🦀"}"#;
        let framed = format!("Content-Length: {}\r\n\r\n{body}", body.len());
        let framed = framed.into_bytes();
        let split = framed.len() / 2;
        let first = framed[..split].to_vec();
        let second = framed[split..].to_vec();
        tokio::spawn(async move {
            writer.write_all(&first).await.unwrap();
            writer.write_all(&second).await.unwrap();
        });
        let decoded = read_frame(&mut BufReader::new(reader)).await.unwrap();
        assert_eq!(decoded.as_deref(), Some(body));
    }

    #[tokio::test]
    async fn frame_reader_rejects_duplicate_length() {
        let (mut writer, reader) = tokio::io::duplex(256);
        tokio::spawn(async move {
            writer
                .write_all(b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
        });
        let error = read_frame(&mut BufReader::new(reader)).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn frame_writer_uses_byte_length_and_validates_json_objects() {
        let (writer, mut reader) = tokio::io::duplex(256);
        let body = r#"{"value":"🦀"}"#;
        tokio::spawn(async move {
            let mut writer = writer;
            write_frame(&mut writer, body).await.unwrap();
        });
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut bytes)
            .await
            .unwrap();
        let output = String::from_utf8(bytes).unwrap();
        assert!(output.starts_with(&format!("Content-Length: {}\r\n\r\n", body.len())));
        assert!(validate_outbound_message("[]").is_err());
        assert!(validate_outbound_message("not json").is_err());
    }
}
