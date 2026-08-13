use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Hard cap above which a file's content is never read into memory — the
/// frontend's own softer "large file" guard (disabling minimap/tokenization)
/// kicks in well below this; this is just the absolute ceiling that keeps a
/// pathological file from hanging the renderer.
const MAX_READ_BYTES: u64 = 20 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8192;

/// Joins `rel_path` onto `worktree_root`, rejecting anything that isn't a
/// plain relative path under the root: absolute paths (including Windows
/// drive-prefixed ones), and `..`/root components. This is a lexical guard
/// — it doesn't require the target to exist (unlike a canonicalize-based
/// check), which matters for `create_entry`/`rename_entry` targets that
/// don't exist yet. Every fs command below calls this first.
/// NUL-in-first-8KB sniff, shared with `git.rs`'s diff binary-detection
/// fallback for untracked files (where `git diff --numstat` reports
/// nothing to sniff against) — one heuristic, not two copies of it.
pub fn looks_binary(bytes: &[u8]) -> bool {
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    bytes[..sniff_len].contains(&0)
}

pub fn safe_join(worktree_root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() {
        return Ok(worktree_root.to_path_buf());
    }
    let mut result = worktree_root.to_path_buf();
    for component in Path::new(rel_path).components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::CurDir => {}
            _ => return Err(format!("invalid or unsafe path: {rel_path}")),
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub is_symlink: bool,
}

/// Lists the immediate children of `rel_dir`, directories first then
/// alphabetical (case-insensitive), skipping `.git`. Not recursive — the
/// tree is built lazily, per-directory, on expand (see explorerStore.ts).
pub async fn list_dir(worktree_root: &Path, rel_dir: &str) -> Result<Vec<FsEntry>, String> {
    let dir = safe_join(worktree_root, rel_dir)?;
    let mut read_dir = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        let rel_path = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        entries.push(FsEntry {
            name,
            rel_path,
            is_dir: metadata.is_dir(),
            size_bytes: metadata.len(),
            is_symlink: metadata.is_symlink(),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

fn mtime_millis(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileReadResult {
    Text {
        content: String,
        size_bytes: u64,
        mtime_ms: i64,
    },
    Binary {
        size_bytes: u64,
    },
    TooLarge {
        size_bytes: u64,
    },
}

/// Reads a file, classifying it as text/binary/too-large before handing
/// content back. Binary detection: a NUL byte in the first 8KB is the fast
/// path; anything that survives that but still isn't valid UTF-8 (checked
/// against the *whole* file, not the sniff window, to avoid misclassifying
/// a multi-byte character split across the sniff boundary) is also binary.
pub async fn read_file(worktree_root: &Path, rel_path: &str) -> Result<FileReadResult, String> {
    let path = safe_join(worktree_root, rel_path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_READ_BYTES {
        return Ok(FileReadResult::TooLarge { size_bytes });
    }

    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Ok(FileReadResult::Binary { size_bytes });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileReadResult::Text {
            content,
            size_bytes,
            mtime_ms: mtime_millis(&metadata),
        }),
        Err(_) => Ok(FileReadResult::Binary { size_bytes }),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: i64,
}

/// Writes `content`, optionally guarded by `expected_mtime_ms` (the mtime
/// the frontend last loaded/saved) — if the on-disk mtime has since moved,
/// the file changed externally between load and save and this errors
/// instead of silently overwriting; the frontend surfaces that as the
/// external-change prompt rather than a blind "keep mine".
pub async fn write_file(
    worktree_root: &Path,
    rel_path: &str,
    content: &str,
    expected_mtime_ms: Option<i64>,
) -> Result<WriteResult, String> {
    let path = safe_join(worktree_root, rel_path)?;

    if let Some(expected) = expected_mtime_ms {
        if let Ok(metadata) = tokio::fs::metadata(&path).await {
            if mtime_millis(&metadata) != expected {
                return Err("conflict: file changed on disk since it was loaded".to_string());
            }
        }
    }

    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(WriteResult {
        mtime_ms: mtime_millis(&metadata),
    })
}

pub async fn create_entry(
    worktree_root: &Path,
    rel_path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let path = safe_join(worktree_root, rel_path)?;
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if is_dir {
        tokio::fs::create_dir_all(&path)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&path, b"")
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Also serves as "move" — a rename to a different directory is just a
/// rename with a different parent in `to_rel`.
pub async fn rename_entry(
    worktree_root: &Path,
    from_rel: &str,
    to_rel: &str,
) -> Result<(), String> {
    let from = safe_join(worktree_root, from_rel)?;
    let to = safe_join(worktree_root, to_rel)?;
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn delete_entry(worktree_root: &Path, rel_path: &str) -> Result<(), String> {
    let path = safe_join(worktree_root, rel_path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(&path)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn safe_join_rejects_traversal_and_absolute_paths() {
        let dir = TempDir::new().unwrap();
        assert!(safe_join(dir.path(), "../etc/passwd").is_err());
        assert!(safe_join(dir.path(), "/etc/passwd").is_err());
        assert!(safe_join(dir.path(), "a/../../b").is_err());
        assert_eq!(
            safe_join(dir.path(), "src/main.rs").unwrap(),
            dir.path().join("src").join("main.rs")
        );
    }

    #[tokio::test]
    async fn lists_directory_dirs_first_skips_git() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("README.md"), "hi").unwrap();
        std::fs::write(dir.path().join("app.ts"), "x").unwrap();

        let entries = list_dir(dir.path(), "").await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "app.ts", "README.md"]);
        assert!(entries[0].is_dir);
    }

    #[tokio::test]
    async fn reads_text_binary_and_too_large_files() {
        let dir = TempDir::new().unwrap();

        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        match read_file(dir.path(), "a.txt").await.unwrap() {
            FileReadResult::Text { content, .. } => assert_eq!(content, "hello world"),
            other => panic!("expected Text, got {other:?}"),
        }

        std::fs::write(dir.path().join("b.bin"), [0u8, 1, 2, 0, 3]).unwrap();
        match read_file(dir.path(), "b.bin").await.unwrap() {
            FileReadResult::Binary { .. } => {}
            other => panic!("expected Binary, got {other:?}"),
        }

        let big = vec![b'x'; (MAX_READ_BYTES + 1) as usize];
        std::fs::write(dir.path().join("c.big"), &big).unwrap();
        match read_file(dir.path(), "c.big").await.unwrap() {
            FileReadResult::TooLarge { size_bytes } => assert_eq!(size_bytes, big.len() as u64),
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn write_conflicts_when_disk_mtime_moved() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "v1").unwrap();
        let loaded = match read_file(dir.path(), "a.txt").await.unwrap() {
            FileReadResult::Text { mtime_ms, .. } => mtime_ms,
            _ => panic!("expected Text"),
        };

        // Simulate an external touch that changes the mtime.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(dir.path().join("a.txt"), "external edit").unwrap();

        let result = write_file(dir.path(), "a.txt", "my edit", Some(loaded)).await;
        assert!(result.is_err());

        // Without an expectation, or with a matching one, it succeeds.
        assert!(write_file(dir.path(), "a.txt", "my edit", None)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn create_rename_delete_round_trip() {
        let dir = TempDir::new().unwrap();
        create_entry(dir.path(), "notes/todo.md", false)
            .await
            .unwrap();
        assert!(dir.path().join("notes/todo.md").exists());

        rename_entry(dir.path(), "notes/todo.md", "notes/done.md")
            .await
            .unwrap();
        assert!(!dir.path().join("notes/todo.md").exists());
        assert!(dir.path().join("notes/done.md").exists());

        delete_entry(dir.path(), "notes").await.unwrap();
        assert!(!dir.path().join("notes").exists());
    }
}
