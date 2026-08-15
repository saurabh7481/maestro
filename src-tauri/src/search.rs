use crate::fs_ops;
use crate::git::run_git;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Files above this are skipped during search/replace — generated
/// bundles, lockfiles-as-data-files, etc. aren't useful search targets and
/// reading each one in full would dominate scan time for no benefit.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MATCHES_PER_FILE: usize = 200;

/// Enumerates every file `search`/quick-open should consider: tracked
/// files plus untracked-but-not-gitignored ones, via the system `git`
/// binary the app already treats as a hard dependency (see `git.rs`) —
/// this gets `.gitignore`-aware enumeration for free instead of a second
/// gitignore-parsing implementation.
pub async fn list_files(worktree_root: &Path) -> Result<Vec<String>, String> {
    let out = run_git(
        worktree_root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )
    .await?;
    Ok(out
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    /// Byte offsets into `line_text`, not char offsets — correct for
    /// ASCII content (the overwhelming majority of source code); a line
    /// with multi-byte UTF-8 before the match would need a byte→UTF-16
    /// conversion the frontend doesn't currently do to highlight exactly
    /// right. Accepted as a known limitation rather than adding that
    /// conversion for what's a highlight-offset nicety.
    pub match_start: u32,
    pub match_end: u32,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

/// Search and replace share this so a match reported by a search is
/// guaranteed replaceable the same way — no risk of the regex engine or
/// escaping behaving differently between the two (see module-level
/// rationale in `commands/search.rs`).
pub fn build_regex(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let base = if options.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!(r"\b{base}\b")
    } else {
        base
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| e.to_string())
}

/// How many files are scanned per round. Doubles as the emit batch size:
/// one `Match` event per round instead of one per matching file, which on
/// a broad query is the difference between a few hundred IPC messages and
/// several thousand (docs/PERFORMANCE_AUDIT.md §2.4).
const SCAN_BATCH_FILES: usize = 32;

/// Ceiling on how many matching files one search reports. A query like `e`
/// on a large repo otherwise streams the whole worktree into the renderer,
/// which no one reads and which costs a DOM row per match. The frontend
/// surfaces this as a "stopped early" note rather than silently pretending
/// the result set is complete.
const MAX_MATCHED_FILES: usize = 2_000;

pub struct SearchOutcome {
    pub files_matched: u32,
    /// True when the scan stopped at `MAX_MATCHED_FILES` with files left
    /// unscanned, so the caller can say so instead of implying completeness.
    pub truncated: bool,
}

/// Reads and scans one file. Entirely synchronous — this is the body of a
/// `spawn_blocking` task, so it deliberately uses `std::fs` rather than
/// tokio's async file API: the work is a bounded read plus a CPU-bound
/// regex pass, which is exactly what the blocking pool is for and what the
/// async runtime's workers should not be doing.
fn scan_file(full_path: &Path, rel_path: String, regex: &Regex) -> Option<FileMatches> {
    let metadata = std::fs::metadata(full_path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(full_path).ok()?;
    if fs_ops::looks_binary(&bytes) {
        return None;
    }
    let content = String::from_utf8(bytes).ok()?;

    let mut matches = Vec::new();
    'lines: for (line_idx, line_text) in content.lines().enumerate() {
        for m in regex.find_iter(line_text) {
            matches.push(SearchMatch {
                line: (line_idx + 1) as u32,
                match_start: m.start() as u32,
                match_end: m.end() as u32,
                line_text: line_text.to_string(),
            });
            if matches.len() >= MAX_MATCHES_PER_FILE {
                break 'lines;
            }
        }
    }
    if matches.is_empty() {
        return None;
    }
    Some(FileMatches {
        path: rel_path,
        matches,
    })
}

/// Scans every file `list_files` returns, invoking `on_batch` once per
/// round of files (so the caller can stream progress rather than waiting
/// for the whole worktree to finish). `cancel` is polled between rounds,
/// not lines — matches `docs/ARCHITECTURE.md §9`'s streaming-command shape
/// used elsewhere (`run_worktree_hook`) without needing a hard mid-file
/// abort.
///
/// Files within a round are scanned in parallel on the blocking pool; the
/// scan used to be a single sequential `for` loop awaiting one file read at
/// a time, which left every core but one idle for the duration of a search
/// (docs/PERFORMANCE_AUDIT.md §2.4). Results are still reported in
/// `git ls-files` order: a round's handles are awaited in the order they
/// were spawned, so parallelism never reorders the result list under the
/// user.
pub async fn search_in_files<F>(
    worktree_root: &Path,
    query: &str,
    options: &SearchOptions,
    cancel: &Arc<AtomicBool>,
    mut on_batch: F,
) -> Result<SearchOutcome, String>
where
    F: FnMut(Vec<FileMatches>),
{
    if query.is_empty() {
        return Ok(SearchOutcome {
            files_matched: 0,
            truncated: false,
        });
    }
    // Shared across the round's blocking tasks — compiled once, not once
    // per file. `Regex` is `Sync`, so this needs no locking.
    let regex = Arc::new(build_regex(query, options)?);
    let files = list_files(worktree_root).await?;
    let mut files_matched = 0u32;
    let mut truncated = false;

    for chunk in files.chunks(SCAN_BATCH_FILES) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let mut handles = Vec::with_capacity(chunk.len());
        for rel_path in chunk {
            let Ok(full_path) = fs_ops::safe_join(worktree_root, rel_path) else {
                continue;
            };
            let regex = regex.clone();
            let rel_path = rel_path.clone();
            handles.push(tokio::task::spawn_blocking(move || {
                scan_file(&full_path, rel_path, &regex)
            }));
        }

        let mut batch = Vec::new();
        for handle in handles {
            // A panicking scan task shouldn't abort the whole search — skip
            // that file the same way an unreadable one is skipped.
            if let Ok(Some(file_matches)) = handle.await {
                batch.push(file_matches);
            }
        }

        if batch.is_empty() {
            continue;
        }
        if files_matched as usize + batch.len() >= MAX_MATCHED_FILES {
            batch.truncate(MAX_MATCHED_FILES - files_matched as usize);
            truncated = true;
        }
        files_matched += batch.len() as u32;
        on_batch(batch);
        if truncated {
            break;
        }
    }

    Ok(SearchOutcome {
        files_matched,
        truncated,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSummary {
    pub files_changed: u32,
    pub replacement_count: u32,
}

/// Replaces every match of `query` with `replacement` across `files`
/// (already-bounded — the caller passes the file set a prior search
/// found, not the whole worktree). `$1`-style backreferences in
/// `replacement` are only expanded in regex mode — in plain-text mode a
/// literal `$` in the replacement box should stay literal, matching how
/// VS Code's find/replace treats the two modes differently.
pub async fn replace_in_files(
    worktree_root: &Path,
    query: &str,
    replacement: &str,
    options: &SearchOptions,
    files: &[String],
) -> Result<ReplaceSummary, String> {
    let regex = build_regex(query, options)?;
    let mut files_changed = 0u32;
    let mut replacement_count = 0u32;

    for rel_path in files {
        let full_path = fs_ops::safe_join(worktree_root, rel_path)?;
        let Ok(bytes) = tokio::fs::read(&full_path).await else {
            continue;
        };
        if fs_ops::looks_binary(&bytes) {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };

        let match_count = regex.find_iter(&content).count() as u32;
        if match_count == 0 {
            continue;
        }
        let new_content = if options.use_regex {
            regex.replace_all(&content, replacement)
        } else {
            regex.replace_all(&content, regex::NoExpand(replacement))
        };
        tokio::fs::write(&full_path, new_content.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        files_changed += 1;
        replacement_count += match_count;
    }
    Ok(ReplaceSummary {
        files_changed,
        replacement_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tempfile::TempDir;
    use tokio::process::Command;

    async fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .await
            .unwrap();
        dir
    }

    fn default_options() -> SearchOptions {
        SearchOptions {
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
        }
    }

    #[tokio::test]
    async fn lists_tracked_and_untracked_but_not_gitignored_files() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("tracked.txt"), "a").unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "b").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "c").unwrap();

        let files = list_files(dir.path()).await.unwrap();
        assert!(files.contains(&"tracked.txt".to_string()));
        assert!(files.contains(&"untracked.txt".to_string()));
        assert!(!files.contains(&"ignored.txt".to_string()));
    }

    #[tokio::test]
    async fn search_finds_matches_across_files() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "hello world\nhello again").unwrap();
        std::fs::write(dir.path().join("b.txt"), "nothing here").unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let mut results = Vec::new();
        let outcome = search_in_files(dir.path(), "hello", &default_options(), &cancel, |batch| {
            results.extend(batch)
        })
        .await
        .unwrap();

        assert_eq!(outcome.files_matched, 1);
        assert!(!outcome.truncated);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "a.txt");
        assert_eq!(results[0].matches.len(), 2);
    }

    #[tokio::test]
    async fn search_is_case_insensitive_by_default() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "Hello World").unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let mut results = Vec::new();
        search_in_files(dir.path(), "hello", &default_options(), &cancel, |batch| {
            results.extend(batch)
        })
        .await
        .unwrap();
        assert_eq!(results.len(), 1);
    }

    /// The scan runs a round's files in parallel on the blocking pool, which
    /// is exactly the change that could silently start reporting results in
    /// completion order instead of `git ls-files` order — a visibly jumbled
    /// results panel. Spans several rounds (`SCAN_BATCH_FILES` is 32) so this
    /// covers ordering *within* a round and *across* rounds.
    #[tokio::test]
    async fn parallel_scan_preserves_file_order_across_batches() {
        let dir = init_repo().await;
        let file_count = SCAN_BATCH_FILES * 3 + 5;
        for i in 0..file_count {
            // Zero-padded so lexical order (what `git ls-files` returns) and
            // numeric order agree, making the expectation unambiguous.
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), "needle").unwrap();
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let mut results = Vec::new();
        let mut batch_count = 0usize;
        let outcome = search_in_files(dir.path(), "needle", &default_options(), &cancel, |batch| {
            batch_count += 1;
            results.extend(batch);
        })
        .await
        .unwrap();

        assert_eq!(outcome.files_matched as usize, file_count);
        assert!(!outcome.truncated);

        let paths: Vec<&str> = results.iter().map(|f| f.path.as_str()).collect();
        let expected: Vec<String> = (0..file_count).map(|i| format!("f{i:04}.txt")).collect();
        assert_eq!(paths, expected);

        // Results arrive batched, not one event per matching file.
        assert!(
            batch_count < file_count,
            "expected batched emission, got {batch_count} callbacks for {file_count} files"
        );
    }

    #[tokio::test]
    async fn cancelling_stops_the_scan_early() {
        let dir = init_repo().await;
        for i in 0..(SCAN_BATCH_FILES * 2) {
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), "needle").unwrap();
        }

        // Pre-cancelled: the very first round check should bail before any
        // file is read.
        let cancel = Arc::new(AtomicBool::new(true));
        let mut results = Vec::new();
        let outcome = search_in_files(dir.path(), "needle", &default_options(), &cancel, |batch| {
            results.extend(batch);
        })
        .await
        .unwrap();

        assert_eq!(outcome.files_matched, 0);
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn replace_updates_matched_files_only() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "foo bar foo").unwrap();
        std::fs::write(dir.path().join("b.txt"), "untouched").unwrap();

        let summary = replace_in_files(
            dir.path(),
            "foo",
            "baz",
            &default_options(),
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(summary.files_changed, 1);
        assert_eq!(summary.replacement_count, 2);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "baz bar baz"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b.txt")).unwrap(),
            "untouched"
        );
    }

    #[tokio::test]
    async fn replace_plain_text_mode_treats_dollar_sign_literally() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "price: X").unwrap();

        replace_in_files(
            dir.path(),
            "X",
            "$1 literally",
            &default_options(),
            &["a.txt".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "price: $1 literally"
        );
    }

    #[tokio::test]
    async fn replace_regex_mode_expands_backreferences() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "John Smith").unwrap();

        let options = SearchOptions {
            case_sensitive: false,
            whole_word: false,
            use_regex: true,
        };
        replace_in_files(
            dir.path(),
            r"(\w+) (\w+)",
            "$2 $1",
            &options,
            &["a.txt".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "Smith John"
        );
    }
}
