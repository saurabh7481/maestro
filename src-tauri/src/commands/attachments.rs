//! Staging files a user attaches to an agent composer (images, PDFs,
//! CSVs, or anything else) into the worktree so they can be handed to the
//! CLI the exact same proven way a typed `@path` mention already is —
//! this deliberately doesn't invent a second, unverified attachment
//! protocol (e.g. inlining base64 image content into the CLI's own stdin
//! JSON), since the file-mention convention is the one mechanism already
//! confirmed working end-to-end.
//!
//! Three ways in, one staging path: pasted bytes
//! (`save_pasted_attachment`), a file already on disk
//! (`copy_file_into_attachments`, used both by paste-by-reference and by
//! the file picker), and the picker itself (`pick_attachment_files`).
//! Files chosen from outside the worktree matter because the composer's
//! "Add context" list can only ever offer what is already in the repo.

use crate::fs_ops::safe_join;
use base64::Engine;
use std::path::{Path, PathBuf};

const ATTACHMENTS_DIR: &str = ".maestro/attachments";

/// A staged attachment is copied into the worktree and then named in the
/// prompt as an `@mention`, so an enormous one costs disk and leaves a
/// file the agent will try to read. Picking a video out of a file browser
/// by mistake is a great deal easier than pasting one, so the limit that
/// used to be implicit (nobody pastes a gigabyte) is now stated. Well
/// above any PDF/CSV/spreadsheet this is meant for.
const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

/// Extensions offered as the file picker's default filter. Deliberately
/// not a whitelist — the "All files" filter below it stays available, and
/// nothing rejects an unusual extension afterwards. This only decides
/// what the dialog shows first.
const ATTACHMENT_EXTENSIONS: &[&str] = &[
    // Documents and data
    "pdf", "csv", "tsv", "md", "markdown", "txt", "text", "log", "json", "jsonl", "yaml", "yml",
    "toml", "xml", "html", "rtf", // Images
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic",
];

/// Just the file's base name — strips any directory components a
/// caller-supplied name might carry, so this can never be used to write
/// outside `ATTACHMENTS_DIR` regardless of what a pasted file's original
/// name/path looked like.
///
/// Whitespace and other separator characters are folded to `-` because a
/// staged file's whole purpose is to be named in the prompt as
/// `@.maestro/attachments/<name>`, and a mention ends at the first space:
/// `@…/1770000000-My Report.pdf` reaches the CLI as a path to
/// `1770000000-My` plus a stray word. Common from a file picker (Downloads
/// is full of names with spaces), rare enough from a paste that it went
/// unnoticed. The extension is preserved so PDF/CSV/image handling still
/// keys off it.
fn sanitized_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("attached-file");
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    // Everything got folded away (a name that was entirely punctuation).
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "attached-file".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Picks the destination under `<worktree_root>/.maestro/attachments/`,
/// prefixed with a millisecond timestamp so staging the same filename
/// twice in one session doesn't silently overwrite the first. Ensures a
/// `.gitignore` sits in that directory the first time it's created, so
/// attachments never show up as untracked changes in the SCM panel —
/// written once, not on every call, and deliberately scoped to this one
/// directory rather than touching the user's own top-level `.gitignore`.
///
/// Returns `(absolute destination, worktree-relative path)`. Separate from
/// the writing itself so a file already on disk can be streamed across
/// with `tokio::fs::copy` instead of being read into memory first.
async fn prepare_attachment_dest(
    worktree_root: &str,
    file_name: &str,
) -> Result<(PathBuf, String), String> {
    let worktree_root = PathBuf::from(worktree_root);
    let attachments_dir = safe_join(&worktree_root, ATTACHMENTS_DIR)?;
    tokio::fs::create_dir_all(&attachments_dir)
        .await
        .map_err(|e| e.to_string())?;

    let gitignore_path = attachments_dir.join(".gitignore");
    if tokio::fs::metadata(&gitignore_path).await.is_err() {
        let _ = tokio::fs::write(&gitignore_path, "*\n").await;
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staged_name = format!("{timestamp}-{}", sanitized_file_name(file_name));
    let rel_path = format!("{ATTACHMENTS_DIR}/{staged_name}");
    let dest = safe_join(&worktree_root, &rel_path)?;
    Ok((dest, rel_path))
}

async fn stage_attachment_bytes(
    worktree_root: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let (dest, rel_path) = prepare_attachment_dest(worktree_root, file_name).await?;
    tokio::fs::write(&dest, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rel_path)
}

fn human_size(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    format!("{mb:.1} MB")
}

/// For a pasted image/file the browser hands over as in-memory bytes
/// (`clipboardData.files` — a real `File` blob, base64-encoded to cross
/// the Tauri IPC boundary since `invoke` payloads are JSON). Returns the
/// worktree-relative path to stage into the composer as an `@mention`.
#[tauri::command]
pub async fn save_pasted_attachment(
    worktree_root: String,
    file_name: String,
    base64_content: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_content)
        .map_err(|e| e.to_string())?;
    stage_attachment_bytes(&worktree_root, &file_name, &bytes).await
}

/// For a file that already exists somewhere on disk — either pasted by
/// reference (a file manager's clipboard puts a `file://` URI on the
/// clipboard, not the file's bytes, resolved to a plain absolute path by
/// the frontend) or chosen through `pick_attachment_files` below. Copies
/// rather than reads-and-reuses-in-place: the source can be anywhere on
/// disk, not necessarily somewhere the CLI would already be allowed to
/// read from, and copying into the worktree is what makes it resolvable
/// via the existing `@mention` mechanism regardless of where it
/// originally lived.
#[tauri::command]
pub async fn copy_file_into_attachments(
    worktree_root: String,
    source_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|e| format!("can't read {source_path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("{source_path} isn't a file"));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{} is {} — too large to attach (limit {})",
            sanitized_file_name(&source_path),
            human_size(metadata.len()),
            human_size(MAX_ATTACHMENT_BYTES)
        ));
    }
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pasted-file");
    let (dest, rel_path) = prepare_attachment_dest(&worktree_root, file_name).await?;
    // Streamed by the OS rather than read into memory first — the picker
    // makes it easy to choose something far bigger than anything anyone
    // would paste.
    tokio::fs::copy(&source, &dest)
        .await
        .map_err(|e| format!("can't copy {source_path}: {e}"))?;
    Ok(rel_path)
}

/// Opens the OS file picker so context can come from anywhere on disk,
/// not just from the worktree the run happens to be in — a spec PDF in
/// Downloads, a CSV exported from a dashboard, a screenshot saved to the
/// desktop. Returns absolute paths for the frontend to feed back through
/// `copy_file_into_attachments`, which is the same route pasted files
/// already take; nothing here invents a second staging mechanism.
///
/// Mirrors `projects.rs::pick_project_folder`: the dialog is callback-
/// based and must not block the event loop, so the result comes back over
/// a oneshot. An empty vec means the user cancelled.
#[tauri::command]
pub async fn pick_attachment_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Add context from your files")
        .add_filter("Documents, data and images", ATTACHMENT_EXTENSIONS)
        // Listed second so the filter above is the default, but present so
        // an extension this list doesn't name is still reachable.
        .add_filter("All files", &["*"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .unwrap_or_default()
        .iter()
        .map(|path| path.to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The point of the file picker: the source lives entirely outside the
    /// worktree, and staging is what makes it reachable as an `@mention`.
    #[tokio::test]
    async fn copies_a_file_from_outside_the_worktree() {
        let worktree = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let source = elsewhere.path().join("spec.pdf");
        std::fs::write(&source, b"%PDF-1.7 pretend").unwrap();

        let rel = copy_file_into_attachments(
            worktree.path().to_str().unwrap().to_string(),
            source.to_str().unwrap().to_string(),
        )
        .await
        .expect("expected the copy to succeed");

        assert!(rel.starts_with(ATTACHMENTS_DIR), "got {rel}");
        assert!(rel.ends_with("-spec.pdf"), "keeps the original name: {rel}");
        assert_eq!(
            std::fs::read(worktree.path().join(&rel)).unwrap(),
            b"%PDF-1.7 pretend"
        );
        // Staged files are Maestro's bookkeeping, not the user's changes —
        // they must not turn up as untracked files in the SCM panel.
        assert_eq!(
            std::fs::read_to_string(worktree.path().join(ATTACHMENTS_DIR).join(".gitignore"))
                .unwrap(),
            "*\n"
        );
    }

    /// Two attachments with the same base name must not collide — the
    /// second would otherwise silently replace the first.
    #[tokio::test]
    async fn staging_the_same_name_twice_keeps_both() {
        let worktree = TempDir::new().unwrap();
        let first = stage_attachment_bytes(worktree.path().to_str().unwrap(), "data.csv", b"a")
            .await
            .unwrap();
        // The staged prefix is a millisecond timestamp, so two calls inside
        // the same millisecond would otherwise land on one name.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let second = stage_attachment_bytes(worktree.path().to_str().unwrap(), "data.csv", b"b")
            .await
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(worktree.path().join(&first)).unwrap(), b"a");
    }

    /// Picking a video by accident is much easier from a file browser than
    /// from a clipboard, so the limit has to be an explained refusal rather
    /// than a multi-gigabyte copy into the user's worktree.
    #[tokio::test]
    async fn refuses_a_file_over_the_size_limit() {
        let worktree = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let source = elsewhere.path().join("huge.mp4");
        // Sparse: costs no real disk, still reports its length.
        let file = std::fs::File::create(&source).unwrap();
        file.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        drop(file);

        let error = copy_file_into_attachments(
            worktree.path().to_str().unwrap().to_string(),
            source.to_str().unwrap().to_string(),
        )
        .await
        .expect_err("expected the oversize file to be refused");
        assert!(error.contains("huge.mp4"), "names the file: {error}");
        assert!(error.contains("too large"), "says why: {error}");
        assert!(
            !worktree
                .path()
                .join(ATTACHMENTS_DIR)
                .join("huge.mp4")
                .exists(),
            "nothing should have been copied"
        );
    }

    /// An attachment is handed to the CLI as `@<path>`, and a mention ends
    /// at the first space — so a staged name containing one would deliver a
    /// truncated path. File pickers make such names common.
    #[tokio::test]
    async fn a_staged_name_never_contains_whitespace() {
        let worktree = TempDir::new().unwrap();
        let rel = stage_attachment_bytes(
            worktree.path().to_str().unwrap(),
            "Q3 Revenue Report (final).csv",
            b"a,b\n",
        )
        .await
        .unwrap();

        assert!(!rel.contains(char::is_whitespace), "got {rel}");
        assert!(rel.ends_with(".csv"), "extension survives: {rel}");
        assert!(rel.contains("Q3-Revenue-Report"), "still readable: {rel}");
        // The mention has to resolve to the file that was actually written.
        assert_eq!(std::fs::read(worktree.path().join(&rel)).unwrap(), b"a,b\n");
    }

    #[test]
    fn a_name_with_nothing_usable_left_still_gets_one() {
        assert_eq!(sanitized_file_name("   "), "attached-file");
        assert_eq!(sanitized_file_name(""), "attached-file");
    }

    /// A caller-supplied name is never allowed to steer the write out of
    /// the attachments directory.
    #[tokio::test]
    async fn a_traversing_file_name_still_lands_in_the_attachments_dir() {
        let worktree = TempDir::new().unwrap();
        let rel = stage_attachment_bytes(
            worktree.path().to_str().unwrap(),
            "../../../etc/passwd",
            b"x",
        )
        .await
        .unwrap();
        assert_eq!(rel.matches("..").count(), 0, "got {rel}");
        assert!(rel.starts_with(ATTACHMENTS_DIR), "got {rel}");
        assert!(rel.ends_with("-passwd"), "got {rel}");
    }
}
