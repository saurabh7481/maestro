//! PTY-backed terminal tab (docs/ROADMAP.md Phase 7) — independent of the
//! agent work. Hand-rolled directly on `portable-pty` rather than
//! `tauri-plugin-pty`: every other long-running child process in this
//! codebase (`hooks.rs`, `agents/`) is already a hand-rolled,
//! `AppState`-keyed-by-id manager, so this stays consistent rather than
//! introducing a plugin dependency for just one tab type.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

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
}

impl TerminalHandle {
    /// The shell's basename (`fish`, `zsh`) — what the Process Manager
    /// shows as the process name, with the full path kept as its detail
    /// line.
    pub fn shell_name(&self) -> &str {
        self.shell
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(self.shell.as_str())
    }
}

fn pty_event_channel(terminal_id: &str) -> String {
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

fn default_shell() -> String {
    passwd_shell()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

#[tauri::command]
pub async fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
    worktree_path: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
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

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // `-l`: run as a login shell, same as every standalone terminal
    // emulator (Alacritty, GNOME Terminal, iTerm2, …) does — without it,
    // `.zprofile`/`.bash_profile`/fish's login block never run, which is
    // exactly the gap that leaves `$XDG_CONFIG_HOME`-dependent rc-file
    // setups (modular `~/.config/<shell>/*.d` sourcing, prompt-theme init)
    // half-initialized even though the shell itself starts fine. Widely
    // supported (bash, zsh, fish, dash all accept it).
    cmd.arg("-l");
    cmd.cwd(&worktree_path);
    // Tauri's own process is normally launched from a desktop entry, not
    // a terminal, so it typically has no `TERM` in its environment at
    // all — which the PTY child would otherwise inherit, leaving
    // ncurses/readline/prompt-theme color detection nowhere to start
    // from. Every real terminal emulator sets both of these itself
    // rather than relying on inheriting them from whatever it was
    // launched from.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

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
                let encoded = base64::engine::general_purpose::STANDARD.encode(&pending);
                let _ = batch_app.emit(&batch_channel, &PtyEvent::Data { base64: encoded });
                pending.clear();
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = terminals.get_mut(&terminal_id) {
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
