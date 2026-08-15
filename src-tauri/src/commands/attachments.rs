//! Staging pasted files (images, PDFs, or any other file the user pastes
//! into an agent composer) into the worktree so they can be handed to
//! the CLI the exact same proven way a typed `@path` mention already is
//! — this deliberately doesn't invent a second, unverified attachment
//! protocol (e.g. inlining base64 image content into the CLI's own
//! stdin JSON), since the file-mention convention is the one mechanism
//! already confirmed working end-to-end.

use crate::fs_ops::safe_join;
use base64::Engine;
use std::path::{Path, PathBuf};

const ATTACHMENTS_DIR: &str = ".maestro/attachments";

/// Just the file's base name — strips any directory components a
/// caller-supplied name might carry, so this can never be used to write
/// outside `ATTACHMENTS_DIR` regardless of what a pasted file's
/// original name/path looked like.
fn sanitized_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("pasted-file")
        .to_string()
}

/// Writes `bytes` under `<worktree_root>/.maestro/attachments/`, prefixed
/// with a millisecond timestamp so pasting the same filename twice in one
/// session doesn't silently overwrite the first paste. Ensures a
/// `.gitignore` sits in that directory the first time it's created, so
/// pasted attachments never show up as untracked changes in the SCM
/// panel — written once, not on every call, and deliberately scoped to
/// this one directory rather than touching the user's own top-level
/// `.gitignore`.
async fn stage_attachment_bytes(
    worktree_root: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
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

    tokio::fs::write(&dest, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rel_path)
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

/// For a file pasted by reference (a file manager's clipboard puts a
/// `file://` URI on the clipboard, not the file's bytes — resolved to a
/// plain absolute path by the frontend before calling this). Copies
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
    let bytes = tokio::fs::read(&source).await.map_err(|e| e.to_string())?;
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pasted-file");
    stage_attachment_bytes(&worktree_root, file_name, &bytes).await
}
