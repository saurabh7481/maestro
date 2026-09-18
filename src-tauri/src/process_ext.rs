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
//!
//! A third child-process hazard lives here for that same reason — every
//! spawn site can hit it, and the fix belongs next to the others rather
//! than copy-pasted into each one: `spawn_retrying_busy` below.

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

/// Attempts and backoff for `spawn_retrying_busy`.
///
/// The window this insures against is a fork/exec race measured in
/// microseconds, so the budget is deliberately tiny: long enough to
/// outlast a scheduling hiccup on a loaded CI runner, short enough that a
/// file which is *genuinely* being written still surfaces its error
/// promptly instead of stalling a turn.
const BUSY_SPAWN_ATTEMPTS: u32 = 5;
const BUSY_SPAWN_BACKOFF: std::time::Duration = std::time::Duration::from_millis(20);

/// Whether `error` is the kernel's "text file busy" (`ETXTBSY`) refusal.
///
/// `ErrorKind::ExecutableFileBusy` is the portable spelling (stabilized in
/// Rust 1.83). The raw errno is checked as well because `ETXTBSY` is 26 on
/// both Linux and Darwin, and a mapping gap in `ErrorKind` would silently
/// downgrade this to "no retry" — the failure mode that is hardest to
/// notice.
pub fn is_text_file_busy(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::ExecutableFileBusy {
        return true;
    }
    #[cfg(unix)]
    {
        if error.raw_os_error() == Some(26) {
            return true;
        }
    }
    false
}

/// `spawn`, retrying while the kernel reports the executable as busy.
///
/// `execve(2)` refuses with `ETXTBSY` whenever the target file is open for
/// writing *anywhere in the system* — `i_writecount > 0` on the inode, not
/// "this process is writing it". That makes it reachable in two ways that
/// have nothing to do with each other:
///
/// - On Unix, a `fork` in any thread inherits a still-open write
///   descriptor, and the child holds it across its own `exec` until the
///   descriptor's `O_CLOEXEC`/exit closes it. Exec'ing the just-written
///   file during that window fails — see rust-lang/rust#114554, which is
///   exactly the shape of the flake this helper was added for (a
///   `cargo test` run where one test wrote a fake CLI and another test's
///   `fork` was holding the descriptor).
/// - In production, an npm-installed agent CLI replacing itself on disk
///   while a turn starts: the self-update is writing the file the spawn is
///   trying to exec.
///
/// Neither is a real error — the file becomes executable again the moment
/// the writer's descriptor closes, typically microseconds later — so a
/// short retry converts a hard failure into a success. Every other error
/// is returned untouched: this must never turn "binary not found" or a
/// permission problem into a delayed version of itself.
pub async fn spawn_retrying_busy(
    command: &mut tokio::process::Command,
) -> std::io::Result<tokio::process::Child> {
    spawn_with_busy_retries(command, BUSY_SPAWN_ATTEMPTS, BUSY_SPAWN_BACKOFF).await
}

/// `spawn_retrying_busy` with an injectable budget, so a test can prove the
/// retry actually rides out an open writer without depending on the
/// production timings landing either side of a scheduler.
async fn spawn_with_busy_retries(
    command: &mut tokio::process::Command,
    attempts: u32,
    backoff: std::time::Duration,
) -> std::io::Result<tokio::process::Child> {
    let mut attempt = 1;
    loop {
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if is_text_file_busy(&error) && attempt < attempts => {
                // Growing backoff: a descriptor closed by a slow writer
                // needs more than one evenly-spaced look to be seen.
                tokio::time::sleep(backoff * attempt).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn recognises_busy_and_nothing_else() {
        assert!(is_text_file_busy(&std::io::Error::from_raw_os_error(26)));
        assert!(is_text_file_busy(&std::io::Error::new(
            std::io::ErrorKind::ExecutableFileBusy,
            "busy",
        )));
        assert!(!is_text_file_busy(&std::io::Error::from_raw_os_error(2)));
        assert!(!is_text_file_busy(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "missing",
        )));
        assert!(!is_text_file_busy(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "not executable",
        )));
    }

    /// Reproduces the kernel condition deterministically: a write descriptor
    /// held open *by this process* is enough to make `execve` return
    /// `ETXTBSY`, so the retry loop has to outlast the writer being closed by
    /// someone else. The budget passed here is far wider than production's,
    /// so the assertion is about the loop riding out a real busy window, not
    /// about this machine's timing.
    #[tokio::test]
    async fn rides_out_a_writer_that_closes_late() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy-script");
        let mut writer = std::fs::File::create(&path).unwrap();
        writer.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
        writer.flush().unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let closer = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            drop(writer);
        });

        let mut command = tokio::process::Command::new(&path);
        let mut child =
            spawn_with_busy_retries(&mut command, 40, std::time::Duration::from_millis(25))
                .await
                .expect("the retry loop should outlast the open writer");
        closer.await.unwrap();

        let status = child.wait().await.unwrap();
        assert!(status.success(), "the script exited {status}");
    }

    /// The counterpart guard: retrying must not swallow a genuine failure.
    #[tokio::test]
    async fn missing_binary_still_fails_fast() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist");
        let started = std::time::Instant::now();

        let mut command = tokio::process::Command::new(&path);
        let error = spawn_retrying_busy(&mut command).await.unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(
            started.elapsed() < BUSY_SPAWN_BACKOFF * BUSY_SPAWN_ATTEMPTS,
            "a non-busy failure must not pay the retry budget"
        );
    }
}
