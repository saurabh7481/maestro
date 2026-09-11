//! PTY-backed terminal tab (docs/ROADMAP.md Phase 7) — independent of the
//! agent work. Hand-rolled directly on `portable-pty` rather than
//! `tauri-plugin-pty`: every other long-running child process in this
//! codebase (`hooks.rs`, `agents/`) is already a hand-rolled,
//! `AppState`-keyed-by-id manager, so this stays consistent rather than
//! introducing a plugin dependency for just one tab type.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

/// Cap on `TerminalHandle::scrollback` — enough for an agent tool call to
/// see several screens of dev-server log output without letting a terminal
/// left running for days grow unbounded. `pub(crate)` so the mobile relay's
/// scrollback route (`relay/routes.rs`) can request the whole buffer
/// without duplicating this number.
pub(crate) const SCROLLBACK_CAP_BYTES: usize = 256 * 1024;

pub struct TerminalHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    /// Reporting fields for the Process Manager (`processes.rs`). The pid
    /// is snapshotted at spawn rather than read from `child` on demand:
    /// `portable_pty::Child::process_id` returns `None` once the child has
    /// been reaped, and a just-exited terminal is exactly the case the
    /// Process Manager most needs to describe.
    pub pid: Option<u32>,
    pub started_at_ms: u64,
    pub worktree_path: String,
    pub shell: String,
    /// Rolling tail of this terminal's raw output, capped at
    /// `SCROLLBACK_CAP_BYTES`, so an agent's `read_terminal_output` MCP tool
    /// (`agents/mcp_tools.rs`) has something to read without Maestro itself
    /// keeping a full unbounded transcript. Appended to from the same
    /// per-terminal batching task that emits `pty://{id}/data`.
    pub scrollback: VecDeque<u8>,
}

impl TerminalHandle {
    /// Appends output to `scrollback`, trimming from the front once over
    /// `SCROLLBACK_CAP_BYTES` — a ring buffer, not a growing log.
    fn push_scrollback(&mut self, bytes: &[u8]) {
        self.scrollback.extend(bytes.iter().copied());
        let excess = self.scrollback.len().saturating_sub(SCROLLBACK_CAP_BYTES);
        if excess > 0 {
            self.scrollback.drain(..excess);
        }
    }

    /// The last `max_bytes` of `scrollback`, lossily decoded — output is
    /// arbitrary bytes and the tail cut point can land mid-UTF-8-sequence,
    /// which `from_utf8_lossy` degrades gracefully rather than erroring on.
    pub fn tail(&self, max_bytes: usize) -> String {
        let start = self.scrollback.len().saturating_sub(max_bytes);
        let bytes: Vec<u8> = self.scrollback.iter().skip(start).copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl TerminalHandle {
    /// The shell's basename (`fish`, `zsh`) — what the Process Manager
    /// shows as the process name, with the full path kept as its detail
    /// line.
    pub fn shell_name(&self) -> &str {
        self.shell
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(self.shell.as_str())
    }
}

pub(crate) fn pty_event_channel(terminal_id: &str) -> String {
    format!("pty://{terminal_id}/data")
}

// See `git.rs::DiffContent`'s comment — enum-level `rename_all` doesn't
// cascade into struct-like variants' fields. Harmless today (single-word
// fields), kept for consistency.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PtyEvent {
    /// Base64-encoded — PTY output is arbitrary bytes (can split a
    /// multi-byte UTF-8 sequence across reads), so this is the only safe
    /// way to carry it over a JSON event without corrupting output.
    #[serde(rename_all = "camelCase")]
    Data { base64: String },
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<i32> },
}

/// The user's actually-current login shell, read from `/etc/passwd` —
/// not the `$SHELL` environment variable. `$SHELL` is set once by the
/// display/login manager and then just inherited by every child process
/// from then on; it goes stale the moment the user changes their shell
/// (`chsh`) without logging all the way out and back in. Confirmed live
/// on the dev machine this was debugged against: `getent passwd` says
/// `/bin/fish` (a fully set-up shell — prompt theme, greeting, the
/// works), but the already-running desktop session's inherited `$SHELL`
/// was still `/usr/bin/zsh` — pointed at a shell whose own config was
/// separately broken, which is why the terminal looked plain/broken
/// while every other terminal emulator (reading the same passwd entry)
/// didn't. `/etc/passwd` is the actually-authoritative source those
/// other terminals read instead.
#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    let username = std::env::var("USER").ok()?;
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in passwd.lines() {
        let mut fields = line.split(':');
        if fields.next() == Some(username.as_str()) {
            // Fields are name:password:uid:gid:gecos:home:shell — `next()`
            // above already consumed `name`, so `nth(5)` skips
            // password/uid/gid/gecos/home to land on `shell`.
            return fields.nth(5).map(|s| s.to_string());
        }
    }
    None
}

/// macOS and Linux both read `/etc/passwd` — see `passwd_shell`'s own
/// comment for why that beats `$SHELL`.
#[cfg(unix)]
fn default_shell() -> String {
    passwd_shell()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

/// Whether `name` (an exe/binary filename) resolves on `PATH` — same
/// search `CommandBuilder`/`std::process::Command` would eventually do
/// internally (see `portable-pty`'s `search_path`), used here to check
/// *before* spawning rather than only discovering absence via a failed
/// spawn. Shared by Windows's `default_shell()` (`pwsh.exe` vs
/// `powershell.exe`) and both platforms' `open_system_terminal` that need
/// to probe for an installed terminal emulator (Windows: Windows
/// Terminal; Linux: no single blessed default, see that function). Not
/// needed on macOS, whose `open_system_terminal` can just assume
/// Terminal.app.
#[cfg(any(windows, target_os = "linux"))]
fn binary_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// Windows has no login-shell/passwd concept, and `$SHELL` is a Unix
/// convention that isn't set here at all — so instead of the Unix
/// heuristic above, this walks `PATH` itself to prefer a real, present
/// shell over just assuming one exists.
///
/// PowerShell 7 (`pwsh`) is preferred when installed — it's the actively
/// developed one, cross-platform-consistent with the shell this app's own
/// scripts assume, and what a user who bothered to install it wants over
/// the legacy one still shipped for compatibility. Windows PowerShell
/// (`powershell.exe`) ships in every Windows install under
/// `%SystemRoot%\System32\WindowsPowerShell\v1.0`, which is unconditionally
/// on `PATH`, so it is the realistic universal fallback — `cmd.exe` (via
/// `ComSpec`) only matters if `PATH` has been stripped down.
#[cfg(windows)]
fn default_shell() -> String {
    if binary_on_path("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    if binary_on_path("powershell.exe") {
        return "powershell.exe".to_string();
    }
    std::env::var("ComSpec")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

/// Optional per-spawn overrides — bundled into one struct rather than two
/// more bare params (clippy's `too_many_arguments` limit).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOverrides {
    /// Settings → Terminal's shell override (`uiStore.terminalShellPath`).
    /// `None`/empty falls back to `default_shell()`, same as before this
    /// existed.
    pub shell_path: Option<String>,
    /// Starting directory, when opened via "New Terminal In Folder…"
    /// (`NewTabMenu.tsx`) — falls back to `worktree_path`. Kept separate
    /// from `worktree_path` itself: the Process Manager and every other
    /// consumer of `TerminalHandle.worktree_path` groups terminals by
    /// worktree, which shouldn't change just because this one shell
    /// started somewhere else inside it.
    pub cwd: Option<String>,
}

#[tauri::command]
pub async fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
    worktree_path: String,
    rows: u16,
    cols: u16,
    overrides: SpawnOverrides,
) -> Result<(), String> {
    let SpawnOverrides { shell_path, cwd } = overrides;
    // A terminal id is a tab id, and a tab can now be handed to a second
    // window (docs/V2_ROADMAP.md Phase 13), whose `TerminalTab` mounts
    // without knowing the PTY is already running and asks for it again.
    // Inserting a second handle under the same key would drop the first
    // one *without killing it*, orphaning a live shell — so an existing
    // id is a no-op here and the new window simply joins the same
    // `pty://{id}/data` stream, which every window receives.
    {
        let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        if terminals.contains_key(&terminal_id) {
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = shell_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    // `-l`: run as a login shell, same as every standalone terminal
    // emulator (Alacritty, GNOME Terminal, iTerm2, …) does — without it,
    // `.zprofile`/`.bash_profile`/fish's login block never run, which is
    // exactly the gap that leaves `$XDG_CONFIG_HOME`-dependent rc-file
    // setups (modular `~/.config/<shell>/*.d` sourcing, prompt-theme init)
    // half-initialized even though the shell itself starts fine. Widely
    // supported (bash, zsh, fish, dash all accept it) — but not a flag
    // `pwsh.exe`/`powershell.exe`/`cmd.exe` understand, so it's Unix-only;
    // Windows shells have no equivalent login/non-login distinction.
    #[cfg(unix)]
    cmd.arg("-l");
    cmd.cwd(cwd.as_deref().unwrap_or(&worktree_path));
    // Tauri's own process is normally launched from a desktop entry, not
    // a terminal, so it typically has no `TERM` in its environment at
    // all — which the PTY child would otherwise inherit, leaving
    // ncurses/readline/prompt-theme color detection nowhere to start
    // from. Every real terminal emulator sets both of these itself
    // rather than relying on inheriting them from whatever it was
    // launched from.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // AppImage's generated `AppRun` prepends `$APPDIR/usr/lib` onto
    // `LD_LIBRARY_PATH` before exec'ing the bundled binary, so `CommandBuilder`
    // — which otherwise inherits Maestro's full environment — hands that
    // straight to the shell, and everything the shell launches, e.g. `git`,
    // inherits it too: they load the AppImage's bundled libs instead of the
    // system's, which is how you get glibc's "no version information
    // available" warning on a plain `git status`. Filtering out only the
    // `$APPDIR`-rooted entries (rather than dropping the variable outright)
    // preserves anything the user legitimately set themselves; mirrors
    // `process_ext.rs`'s `sanitized_ld_library_path`, which fixes the same
    // leak for the app's own git/agent/LSP/hook spawns — that path never
    // touches `terminal.rs` since this PTY shell goes through
    // `portable-pty`, not `std::process::Command`.
    #[cfg(unix)]
    if let Some(appdir) = std::env::var_os("APPDIR") {
        if let Some(current) = std::env::var_os("LD_LIBRARY_PATH") {
            let filtered: Vec<_> = std::env::split_paths(&current)
                .filter(|p| !p.starts_with(&appdir))
                .collect();
            if let Ok(joined) = std::env::join_paths(&filtered) {
                cmd.env("LD_LIBRARY_PATH", joined);
            }
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave side is only needed to spawn the child — dropping it here
    // (rather than holding it for the terminal's lifetime) matches
    // portable-pty's own examples and avoids leaking an unused fd.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let pid = child.process_id();
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.insert(
            terminal_id.clone(),
            TerminalHandle {
                writer,
                master: pair.master,
                child,
                pid,
                started_at_ms: crate::processes::now_ms(),
                worktree_path: worktree_path.clone(),
                shell,
                scrollback: VecDeque::new(),
            },
        );
    }

    // Blocking reads run on a dedicated OS thread, not the async
    // runtime's workers — a busy terminal must not starve agent-process
    // I/O sharing the same runtime (docs/ARCHITECTURE.md §8).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Coalesces output toward the frontend at roughly animation-frame
    // cadence rather than one event per read (docs/ARCHITECTURE.md §9),
    // and reaps the child once the PTY closes (process exited, or
    // `kill_terminal` dropped the handle out from under this loop).
    let batch_app = app.clone();
    let batch_channel = pty_event_channel(&terminal_id);
    let batch_terminal_id = terminal_id.clone();
    tokio::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let got = tokio::time::timeout(Duration::from_millis(16), rx.recv()).await;
            match got {
                Ok(Some(chunk)) => pending.extend_from_slice(&chunk),
                Ok(None) => {
                    // Reader thread exited (EOF or its own read error) —
                    // flush whatever's left, then reap.
                    while let Ok(chunk) = rx.try_recv() {
                        pending.extend_from_slice(&chunk);
                    }
                    if !pending.is_empty() {
                        append_scrollback(&batch_app, &batch_terminal_id, &pending);
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&pending);
                        let _ = batch_app.emit(&batch_channel, &PtyEvent::Data { base64: encoded });
                    }
                    let handle = {
                        let state = batch_app.state::<AppState>();
                        let mut terminals = state.terminals.lock().ok();
                        terminals
                            .as_mut()
                            .and_then(|t| t.remove(&batch_terminal_id))
                    };
                    let code = if let Some(mut handle) = handle {
                        tokio::task::spawn_blocking(move || {
                            handle
                                .child
                                .wait()
                                .ok()
                                .and_then(|status| status.exit_code().into())
                        })
                        .await
                        .ok()
                        .flatten()
                    } else {
                        None
                    };
                    let _ = batch_app.emit(
                        &batch_channel,
                        &PtyEvent::Exit {
                            code: code.map(|c: u32| c as i32),
                        },
                    );
                    break;
                }
                Err(_) => {}
            }
            while let Ok(chunk) = rx.try_recv() {
                pending.extend_from_slice(&chunk);
            }
            if !pending.is_empty() {
                append_scrollback(&batch_app, &batch_terminal_id, &pending);
                let encoded = base64::engine::general_purpose::STANDARD.encode(&pending);
                let _ = batch_app.emit(&batch_channel, &PtyEvent::Data { base64: encoded });
                pending.clear();
            }
        }
    });

    Ok(())
}

/// Shared by both flush sites in the batching loop above — locks
/// `state.terminals` just long enough to append one chunk to a terminal's
/// scrollback ring buffer. A missing entry (already reaped) is a silent
/// no-op, same tolerance the rest of this loop already has for a terminal
/// that's gone away mid-flush.
fn append_scrollback(app: &AppHandle, terminal_id: &str, bytes: &[u8]) {
    let state = app.state::<AppState>();
    let Ok(mut terminals) = state.terminals.lock() else {
        return;
    };
    if let Some(handle) = terminals.get_mut(terminal_id) {
        handle.push_scrollback(bytes);
    }
}

/// Core of `write_terminal`, factored out so the `send_terminal_input` MCP
/// tool (`agents/mcp_tools.rs`) can write to the same PTY through the same
/// path rather than duplicating the lock/lookup/write.
pub fn write_to_terminal(state: &AppState, terminal_id: &str, data: &str) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = terminals.get_mut(terminal_id) {
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    write_to_terminal(&state, &terminal_id, &data)
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = terminals.get(&terminal_id) {
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn kill_terminal(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    let handle = {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.remove(&terminal_id)
    };
    if let Some(mut handle) = handle {
        let _ = handle.child.kill();
    }
    Ok(())
}

/// Launches the OS's own terminal app at `path` — a genuinely independent
/// process, unlike every other command in this file: not tracked in
/// `AppState.terminals`, not reaped on app quit, nothing here manages its
/// lifetime once spawned.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn open_system_terminal(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Terminal", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Windows Terminal (`wt.exe`) when installed — the modern default on
/// Windows 11 and a common install on 10 — else a plain `cmd.exe` window,
/// which (unlike `wt.exe`) is guaranteed present on every Windows install.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn open_system_terminal(path: String) -> Result<(), String> {
    if binary_on_path("wt.exe") {
        std::process::Command::new("wt.exe")
            .args(["-d", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/K", &format!("cd /d {path}")])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// No single blessed default terminal emulator on Linux the way macOS has
/// Terminal.app or Windows has `wt.exe`/`cmd.exe` — this probes, in order:
/// `x-terminal-emulator` (the Debian/Ubuntu alternatives symlink to
/// whichever terminal the user or distro actually configured as default,
/// so it's checked first specifically to respect that choice over this
/// list's own opinion), then the common desktop-environment terminals,
/// then `xterm` as the last-resort fallback virtually every X11 install
/// has. Every candidate is launched with `current_dir(path)` rather than
/// an emulator-specific "start here" flag — those flags' names and syntax
/// differ per emulator (`--working-directory=X` vs `--workdir X` vs none
/// at all), while inheriting the launching process's cwd is the one
/// mechanism every terminal here actually honors for its initial shell.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn open_system_terminal(path: String) -> Result<(), String> {
    const CANDIDATES: &[&str] = &[
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "alacritty",
        "kitty",
        "xterm",
    ];
    let Some(terminal) = CANDIDATES.iter().find(|name| binary_on_path(name)) else {
        return Err(
            "No terminal emulator found on PATH. Install one (gnome-terminal, konsole, xterm, …) \
             to use \"Open in System Terminal\"."
                .to_string(),
        );
    };
    use crate::process_ext::HiddenCommandExt;
    std::process::Command::new(terminal)
        .current_dir(&path)
        // Strips any AppImage-injected LD_LIBRARY_PATH before spawning —
        // see `process_ext.rs`'s doc comment. A no-op window-wise here
        // (this app isn't Windows), only the env fix applies.
        .hide_window()
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kills every live terminal — called from `lib.rs`'s `ExitRequested`
/// handler so a quit doesn't orphan shell processes (docs/CHECKLIST.md).
pub fn kill_all(state: &AppState) {
    let mut terminals = match state.terminals.lock() {
        Ok(t) => t,
        Err(_) => return,
    };
    for (_, mut handle) in terminals.drain() {
        let _ = handle.child.kill();
    }
}
