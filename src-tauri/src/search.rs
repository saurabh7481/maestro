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

/// Scans every file `list_files` returns, invoking `on_file_match` once
/// per matching file (so the caller can stream progress rather than
/// waiting for the whole worktree to finish). Returns the number of files
/// that matched. `cancel` is polled between files, not lines — matches
/// `docs/ARCHITECTURE.md §9`'s streaming-command shape used elsewhere
/// (`run_worktree_hook`) without needing a hard mid-file abort.
pub async fn search_in_files<F>(
    worktree_root: &Path,
    query: &str,
    options: &SearchOptions,
    cancel: &Arc<AtomicBool>,
    mut on_file_match: F,
) -> Result<u32, String>
where
    F: FnMut(FileMatches),
{
    if query.is_empty() {
        return Ok(0);
    }
    let regex = build_regex(query, options)?;
    let files = list_files(worktree_root).await?;
    let mut files_matched = 0u32;

    for rel_path in files {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(full_path) = fs_ops::safe_join(worktree_root, &rel_path) else {
            continue;
        };
        let Ok(metadata) = tokio::fs::metadata(&full_path).await else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = tokio::fs::read(&full_path).await else {
            continue;
        };
        if fs_ops::looks_binary(&bytes) {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };

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
        if !matches.is_empty() {
            files_matched += 1;
            on_file_match(FileMatches {
                path: rel_path,
                matches,
            });
        }
    }
    Ok(files_matched)
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
        let files_matched =
            search_in_files(dir.path(), "hello", &default_options(), &cancel, |fm| {
                results.push(fm)
            })
            .await
            .unwrap();

        assert_eq!(files_matched, 1);
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
        search_in_files(dir.path(), "hello", &default_options(), &cancel, |fm| {
            results.push(fm)
        })
        .await
        .unwrap();
        assert_eq!(results.len(), 1);
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
