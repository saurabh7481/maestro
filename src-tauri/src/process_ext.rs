//! Every headless child process this app spawns (`git`, ripgrep, LSP
//! servers, agent CLIs, hook scripts, ...) is a console-subsystem
//! executable. Launched from a GUI-subsystem parent on Windows, each one
//! briefly allocates and shows its own console window — with `git status`
//! rerun on every filesystem change and agent/LSP processes spawned
//! throughout a session, that reads to a user as a continuous flicker of
//! terminal windows opening and closing. `CREATE_NO_WINDOW` suppresses it.
//! Not applied in `terminal.rs`: that PTY is the one deliberately visible
//! shell and goes through `portable-pty`, not this module.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait HiddenCommandExt {
    /// No-op on non-Windows targets.
    fn hide_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl HiddenCommandExt for std::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl HiddenCommandExt for std::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(windows)]
impl HiddenCommandExt for tokio::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl HiddenCommandExt for tokio::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        self
    }
}

/// Resolves a bare executable name (`"claude"`, `"typescript-language-
/// server"`, ...) the way a real Windows shell would, before handing it to
/// `Command`/`CommandBuilder`.
///
/// `CreateProcessW` — which both `std`/`tokio`'s `Command` and
/// `portable-pty` ultimately call — only ever auto-appends `.exe` to an
/// extension-less program name; unlike `cmd.exe`/PowerShell's own PATH
/// search, it never tries `PATHEXT`'s other entries. Every agent CLI this
/// app wraps that's distributed via npm (Claude Code, Codex, Cursor
/// Agent) — and the two npm-distributed LSP servers
/// (`typescript-language-server`, `pyright-langserver`, see
/// `lsp.rs::install_hint`) — installs on Windows as a `<name>.cmd`/`.ps1`
/// shim, never a bare `.exe`. Left unresolved, spawning any of them by
/// bare name fails with "program not found" even though the same name
/// runs fine typed directly into the user's own PowerShell prompt.
///
/// A no-op on other platforms, and a no-op for anything already qualified
/// (contains a path separator, or already carries an extension) — a
/// user-supplied override path should never be second-guessed.
#[cfg(windows)]
pub fn resolve_executable(name: &str) -> std::path::PathBuf {
    let path = std::path::Path::new(name);
    if path.components().count() > 1 || path.extension().is_some() {
        return path.to_path_buf();
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let Some(path_var) = std::env::var_os("PATH") else {
        return path.to_path_buf();
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in pathext.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
pub fn resolve_executable(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
}
