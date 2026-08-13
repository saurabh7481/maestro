use std::path::{Path, PathBuf};
use tokio::process::Command;

/// Shells out to the system `git` binary rather than a libgit2 binding —
/// `git worktree` support in libgit2-based bindings (Rust's `git2`
/// included) is incomplete/unreliable. See docs/ARCHITECTURE.md §7.
async fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn is_git_repo(path: &Path) -> bool {
    run_git(path, &["rev-parse", "--is-inside-work-tree"])
        .await
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
}

/// Parses `git worktree list --porcelain` output. Entries are blank-line
/// separated blocks of `key value` lines (`worktree`, `HEAD`, `branch`) plus
/// bare flag-only lines (`bare`, `detached`, `locked ...`, `prunable ...`).
pub async fn list_worktrees(repo_dir: &Path) -> Result<Vec<WorktreeEntry>, String> {
    let out = run_git(repo_dir, &["worktree", "list", "--porcelain"]).await?;

    let mut entries = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch: Option<String> = None;
    let mut is_bare = false;
    let mut is_detached = false;
    let mut is_locked = false;

    let flush = |path: &mut Option<PathBuf>,
                 branch: &mut Option<String>,
                 is_bare: &mut bool,
                 is_detached: &mut bool,
                 is_locked: &mut bool,
                 entries: &mut Vec<WorktreeEntry>| {
        if let Some(p) = path.take() {
            entries.push(WorktreeEntry {
                path: p,
                branch: branch.take(),
                is_bare: *is_bare,
                is_detached: *is_detached,
                is_locked: *is_locked,
            });
        }
        *is_bare = false;
        *is_detached = false;
        *is_locked = false;
    };

    for line in out.lines() {
        if line.is_empty() {
            flush(
                &mut path,
                &mut branch,
                &mut is_bare,
                &mut is_detached,
                &mut is_locked,
                &mut entries,
            );
        } else if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(rest));
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(rest.trim_start_matches("refs/heads/").to_string());
        } else if line == "bare" {
            is_bare = true;
        } else if line == "detached" {
            is_detached = true;
        } else if line.starts_with("locked") {
            is_locked = true;
        }
    }
    flush(
        &mut path,
        &mut branch,
        &mut is_bare,
        &mut is_detached,
        &mut is_locked,
        &mut entries,
    );

    Ok(entries)
}

pub async fn list_branches(repo_dir: &Path) -> Result<Vec<String>, String> {
    let out = run_git(
        repo_dir,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )
    .await?;
    Ok(out
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

/// Creates a new worktree. When `create_branch` is true, creates
/// `branch_name` off `base_ref` (`git worktree add -b`); otherwise checks
/// out the already-existing `branch_name`.
pub async fn worktree_add(
    repo_dir: &Path,
    new_path: &Path,
    branch_name: &str,
    base_ref: &str,
    create_branch: bool,
) -> Result<(), String> {
    let path_str = new_path.to_string_lossy().to_string();
    if create_branch {
        run_git(
            repo_dir,
            &["worktree", "add", "-b", branch_name, &path_str, base_ref],
        )
        .await?;
    } else {
        run_git(repo_dir, &["worktree", "add", &path_str, branch_name]).await?;
    }
    Ok(())
}

pub async fn worktree_remove(
    repo_dir: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), String> {
    let path_str = worktree_path.to_string_lossy().to_string();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path_str);
    run_git(repo_dir, &args).await?;
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct StatusSummary {
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub changed_files: u32,
}

/// Local-only ahead/behind + dirty check (`git status --porcelain=v2
/// --branch`) — no network fetch, so this never blocks on a remote.
pub async fn status_summary(worktree_dir: &Path) -> StatusSummary {
    let Ok(out) = run_git(worktree_dir, &["status", "--porcelain=v2", "--branch"]).await else {
        return StatusSummary::default();
    };

    let mut summary = StatusSummary::default();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if let [ahead, behind] = parts[..] {
                summary.ahead = ahead.trim_start_matches('+').parse().unwrap_or(0);
                summary.behind = behind.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if !line.starts_with('#') {
            summary.dirty = true;
            summary.changed_files += 1;
        }
    }
    summary
}

pub async fn is_dirty(worktree_dir: &Path) -> bool {
    status_summary(worktree_dir).await.dirty
}

/// Best-effort install-command guess from lockfiles/manifests present at
/// the repo root — surfaced as a suggestion in the hooks UI, never run
/// without the user opting in.
pub fn detect_install_command(repo_dir: &Path) -> Option<String> {
    let has = |name: &str| repo_dir.join(name).exists();
    if has("pnpm-lock.yaml") {
        Some("pnpm install".to_string())
    } else if has("yarn.lock") {
        Some("yarn install".to_string())
    } else if has("package-lock.json") || has("package.json") {
        Some("npm install".to_string())
    } else if has("Cargo.toml") {
        Some("cargo build".to_string())
    } else if has("go.mod") {
        Some("go mod download".to_string())
    } else if has("requirements.txt") {
        Some("pip install -r requirements.txt".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        run_git(dir.path(), &["init", "-b", "main"]).await.unwrap();
        run_git(dir.path(), &["config", "user.email", "test@example.com"])
            .await
            .unwrap();
        run_git(dir.path(), &["config", "user.name", "Test"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("README.md"), "hello").unwrap();
        run_git(dir.path(), &["add", "."]).await.unwrap();
        run_git(dir.path(), &["commit", "-m", "init"])
            .await
            .unwrap();
        dir
    }

    #[tokio::test]
    async fn detects_git_repo() {
        let dir = init_repo().await;
        assert!(is_git_repo(dir.path()).await);

        let not_repo = TempDir::new().unwrap();
        assert!(!is_git_repo(not_repo.path()).await);
    }

    #[tokio::test]
    async fn lists_primary_worktree() {
        let dir = init_repo().await;
        let entries = list_worktrees(dir.path()).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert!(!entries[0].is_detached);
    }

    #[tokio::test]
    async fn creates_and_removes_worktree() {
        let dir = init_repo().await;
        let wt_path = dir.path().join("wt-feature");
        worktree_add(dir.path(), &wt_path, "feature", "main", true)
            .await
            .unwrap();

        let entries = list_worktrees(dir.path()).await.unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|e| e.branch.as_deref() == Some("feature")));

        worktree_remove(dir.path(), &wt_path, false).await.unwrap();
        let entries = list_worktrees(dir.path()).await.unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[tokio::test]
    async fn dirty_check_reflects_working_tree_state() {
        let dir = init_repo().await;
        assert!(!is_dirty(dir.path()).await);
        std::fs::write(dir.path().join("scratch.txt"), "x").unwrap();
        assert!(is_dirty(dir.path()).await);
    }

    #[tokio::test]
    async fn git_itself_refuses_to_remove_a_dirty_worktree_without_force() {
        let dir = init_repo().await;
        let wt_path = dir.path().join("wt-feature");
        worktree_add(dir.path(), &wt_path, "feature", "main", true)
            .await
            .unwrap();
        std::fs::write(wt_path.join("scratch.txt"), "x").unwrap();
        assert!(is_dirty(&wt_path).await);

        // The Tauri command layer (commands/worktrees.rs) also guards this
        // up front with a friendlier error, but git's own refusal is the
        // backstop this test exercises.
        assert!(worktree_remove(dir.path(), &wt_path, false).await.is_err());
    }

    #[test]
    fn detects_install_command_from_lockfiles() {
        let dir = TempDir::new().unwrap();
        assert_eq!(detect_install_command(dir.path()), None);

        std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(
            detect_install_command(dir.path()),
            Some("pnpm install".to_string())
        );
    }
}
