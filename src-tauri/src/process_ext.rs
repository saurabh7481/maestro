//! Every headless child process this app spawns (`git`, ripgrep, LSP
//! servers, agent CLIs, hook scripts, ...) is a console-subsystem
//! executable. Launched from a GUI-subsystem parent on Windows, each one
//! briefly allocates and shows its own console window — with `git status`
//! rerun on every filesystem change and agent/LSP processes spawned
//! throughout a session, that reads to a user as a continuous flicker of
//! terminal windows opening and closing. `CREATE_NO_WINDOW` suppresses it.
//! Not applied in `terminal.rs`: that PTY is the one deliberately visible
//! shell and goes through `portable-pty`, not this module.
//!
//! On Linux, the same `hide_window()` call site doubles as the fix for a
//! second, unrelated problem with the exact same shape (one child-process
//! prep step every spawn site already needs): see
//! `sanitized_ld_library_path` below.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// AppImage's generated `AppRun` prepends `$APPDIR/usr/lib` onto
/// `LD_LIBRARY_PATH` before exec'ing the bundled binary, so *every* child
/// process this app spawns inherits it too — including the system's own
/// `git`. The libcurl/libpcre2 etc. bundled in `$APPDIR/usr/lib` for the
/// embedded webview don't match what e.g. `/usr/lib/git-core/git-remote-
/// https` was actually linked against, so a spawned `git push`/`pull`
/// fails hard (live-observed on a Linux AppImage build: `git-remote-
/// https: symbol lookup error: .../libcurl.so.4: undefined symbol:
/// nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation`).
/// Stripping the `$APPDIR`-rooted entries back out of `LD_LIBRARY_PATH`
/// before spawning restores the system libraries a spawned system binary
/// expects. `APPDIR` is only ever set when actually running from an
/// extracted/mounted AppImage, so this is `None` (no override applied) on
/// every other build, including a plain `cargo run`/`.deb` install.
#[cfg(not(windows))]
fn sanitized_ld_library_path() -> Option<std::ffi::OsString> {
    let appdir = std::env::var_os("APPDIR")?;
    let current = std::env::var_os("LD_LIBRARY_PATH")?;
    let filtered: Vec<_> = std::env::split_paths(&current)
        .filter(|p| !p.starts_with(&appdir))
        .collect();
    std::env::join_paths(&filtered).ok()
}

pub trait HiddenCommandExt {
    /// Windows: suppresses the child's console window. Linux: also
    /// strips any AppImage-injected `LD_LIBRARY_PATH` entries so spawned
    /// system binaries load the system's own shared libraries (see
    /// `sanitized_ld_library_path`). A genuine no-op on macOS, and on
    /// Linux outside an AppImage.
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
        if let Some(path) = sanitized_ld_library_path() {
            self.env("LD_LIBRARY_PATH", path);
        }
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
        if let Some(path) = sanitized_ld_library_path() {
            self.env("LD_LIBRARY_PATH", path);
        }
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
