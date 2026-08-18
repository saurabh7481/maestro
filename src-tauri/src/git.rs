use crate::fs_ops;
use crate::process_ext::HiddenCommandExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// Shells out to the system `git` binary rather than a libgit2 binding —
/// `git worktree` support in libgit2-based bindings (Rust's `git2`
/// included) is incomplete/unreliable. See docs/ARCHITECTURE.md §7.
/// `pub(crate)` so `search.rs` can reuse it for `git ls-files`-based file
/// enumeration instead of a second gitignore-parsing implementation.
pub(crate) async fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .hide_window()
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
/// --branch`) — no network fetch, so this never blocks on a remote. Used
/// by the worktree-list sidebar, which needs this summary for every
/// worktree of every project — `working_status`'s full per-file
/// staged/unstaged breakdown below is unnecessary work at that scale, so
/// this stays its own lightweight call rather than being layered on top.
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

/// A single file's git status, per side of the index. Richer than a
/// single glyph — the porcelain v2 XY pair already distinguishes staged
/// (X) from unstaged (Y) status, and a path can legitimately carry both
/// (a partially-staged file).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatusKind {
    Modified,
    Added,
    Deleted,
    TypeChanged,
    Renamed { similarity: u8 },
    Copied { similarity: u8 },
    Untracked,
    Conflicted { ours: char, theirs: char },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Populated only for `Renamed`/`Copied` staged entries.
    pub old_path: Option<String>,
    pub staged: Option<StatusKind>,
    pub unstaged: Option<StatusKind>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<FileStatus>,
}

fn status_kind_for(code: char) -> Option<StatusKind> {
    match code {
        'M' => Some(StatusKind::Modified),
        'A' => Some(StatusKind::Added),
        'D' => Some(StatusKind::Deleted),
        'T' => Some(StatusKind::TypeChanged),
        // '.' means unmodified on that side; anything else unrecognized.
        _ => None,
    }
}

/// `1 XY sub mH mI mW hH hI <path>` with the `1 ` prefix already stripped —
/// 8 space-separated fixed fields before path, `splitn` so a path containing
/// spaces (possible under `-z`, which disables quoting) isn't truncated.
fn parse_ordinary(rest: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = rest.splitn(8, ' ').collect();
    (parts.len() == 8).then(|| (parts[0].to_string(), parts[7].to_string()))
}

/// `2 XY sub mH mI mW hH hI Xscore <path>` — returns the unstaged (Y) code,
/// the rename/copy kind letter + similarity parsed out of `Xscore` (e.g.
/// `R100`, `C75`), and the new path. The old path is a *separate*
/// NUL-terminated record under `-z` immediately following this one — the
/// caller consumes it from the chunk iterator, not from this line.
fn parse_rename(rest: &str) -> Option<(char, char, u8, String)> {
    let parts: Vec<&str> = rest.splitn(9, ' ').collect();
    if parts.len() != 9 {
        return None;
    }
    let mut xy = parts[0].chars();
    xy.next()?; // X is always 'R' or 'C' here, redundant with the Xscore field below
    let y = xy.next()?;
    let mut score = parts[7].chars();
    let kind = score.next()?;
    let similarity: u8 = score.as_str().parse().unwrap_or(0);
    Some((y, kind, similarity, parts[8].to_string()))
}

/// `u XY sub m1 m2 m3 mW h1 h2 h3 <path>` with the `u ` prefix stripped.
fn parse_unmerged(rest: &str) -> Option<(char, char, String)> {
    let parts: Vec<&str> = rest.splitn(10, ' ').collect();
    if parts.len() != 10 {
        return None;
    }
    let mut xy = parts[0].chars();
    let x = xy.next()?;
    let y = xy.next()?;
    Some((x, y, parts[9].to_string()))
}

/// Rich per-file staged/unstaged status plus ahead/behind, from a single
/// `git status --porcelain=v2 --branch -z` call. `-z` NUL-terminates every
/// record, including a rename/copy (`2 `) record's old-path, which arrives
/// as its own separate chunk immediately after — a naive per-chunk parse
/// with no lookahead silently drops it, so this walks the chunks with a
/// `Peekable`-style `next()` call from within the `2 ` branch to consume
/// it explicitly. Unmerged (`u `) entries are surfaced as `Conflicted`,
/// never collapsed into `Modified` — conflicts need to be visibly distinct
/// in the SCM view, not silently shown as a plain change.
///
/// `--untracked-files=all`: without it, git's default ("normal") mode
/// collapses an entirely-untracked directory into one `? <dir>/` entry
/// instead of listing the files inside it — fine for `git status` on a
/// terminal, but wrong for a UI that's meant to list files one per row
/// (VS Code's git panel always expands these; each `?` entry it shows is
/// a real file, never a directory).
pub async fn working_status(worktree_dir: &Path) -> Result<WorkingStatus, String> {
    let out = run_git(
        worktree_dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?;

    let mut status = WorkingStatus::default();
    let mut chunks = out.split('\0');

    while let Some(chunk) = chunks.next() {
        if chunk.is_empty() {
            continue;
        }
        if let Some(rest) = chunk.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if let [ahead, behind] = parts[..] {
                status.ahead = ahead.trim_start_matches('+').parse().unwrap_or(0);
                status.behind = behind.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = chunk.strip_prefix("1 ") {
            if let Some((xy, path)) = parse_ordinary(rest) {
                let mut xy_chars = xy.chars();
                let x = xy_chars.next().unwrap_or('.');
                let y = xy_chars.next().unwrap_or('.');
                status.entries.push(FileStatus {
                    path,
                    old_path: None,
                    staged: status_kind_for(x),
                    unstaged: status_kind_for(y),
                });
            }
        } else if let Some(rest) = chunk.strip_prefix("2 ") {
            if let Some((y, kind, similarity, path)) = parse_rename(rest) {
                let old_path = chunks.next().map(|s| s.to_string());
                let staged = Some(if kind == 'C' {
                    StatusKind::Copied { similarity }
                } else {
                    StatusKind::Renamed { similarity }
                });
                status.entries.push(FileStatus {
                    path,
                    old_path,
                    staged,
                    unstaged: status_kind_for(y),
                });
            }
        } else if let Some(rest) = chunk.strip_prefix("u ") {
            if let Some((x, y, path)) = parse_unmerged(rest) {
                status.entries.push(FileStatus {
                    path,
                    old_path: None,
                    staged: Some(StatusKind::Conflicted { ours: x, theirs: y }),
                    unstaged: None,
                });
            }
        } else if let Some(path) = chunk.strip_prefix("? ") {
            status.entries.push(FileStatus {
                path: path.to_string(),
                old_path: None,
                staged: None,
                unstaged: Some(StatusKind::Untracked),
            });
        }
    }

    Ok(status)
}

/// One glyph per path for the file tree's overlay, preferring the
/// unstaged side (what you'd act on next) and falling back to staged.
/// `Conflicted` gets its own `'C'` glyph rather than collapsing into `'M'`.
fn display_glyph(entry: &FileStatus) -> Option<char> {
    let kind = entry.unstaged.as_ref().or(entry.staged.as_ref())?;
    Some(match kind {
        StatusKind::Modified | StatusKind::TypeChanged => 'M',
        StatusKind::Added | StatusKind::Renamed { .. } | StatusKind::Copied { .. } => 'A',
        StatusKind::Deleted => 'D',
        StatusKind::Untracked => 'U',
        StatusKind::Conflicted { .. } => 'C',
    })
}

/// Projects an already-computed `WorkingStatus` down to one glyph per
/// path, for the file tree overlay. Exposed separately from `status_map`
/// so callers that already have a `WorkingStatus` in hand (the watcher's
/// debounce callback, which also needs the full status for the `scm://`
/// event) don't have to shell out to `git status` a second time just to
/// get the file-tree's simpler view of the same data.
pub fn status_glyphs(status: &WorkingStatus) -> HashMap<String, char> {
    let mut map = HashMap::new();
    for entry in &status.entries {
        if let Some(glyph) = display_glyph(entry) {
            map.insert(entry.path.clone(), glyph);
        }
    }
    map
}

/// Per-file status glyphs (M/A/D/U/C) for the file tree, keyed by path
/// relative to `worktree_dir`. A thin projection of `working_status` down
/// to one glyph per path — the file tree has no row-level affordance for
/// "this path has both staged and unstaged changes" or "this was renamed
/// from X"; the SCM view's richer display is built from `working_status`
/// directly instead.
pub async fn status_map(worktree_dir: &Path) -> Result<HashMap<String, char>, String> {
    let status = working_status(worktree_dir).await?;
    Ok(status_glyphs(&status))
}

/// Plain-text `git diff --staged`, for feeding into a commit-message
/// generation prompt (`commands/agents.rs::generate_commit_message`) —
/// deliberately not the structured `DiffContent` used by the Monaco diff
/// tab, since this just needs to be text a model reads, not something a
/// UI renders.
pub async fn staged_diff_text(dir: &Path) -> Result<String, String> {
    run_git(dir, &["diff", "--staged"]).await
}

/// `git diff --staged --stat`'s per-file summary (path + insertion/deletion
/// counts) — cheap to compute and gives a commit-message prompt an
/// unambiguous list of exactly which files changed, instead of relying on
/// the model to infer that correctly from `+++`/`---` hunk headers buried
/// in a possibly-truncated full diff.
pub async fn staged_diff_stat(dir: &Path) -> Result<String, String> {
    run_git(dir, &["diff", "--staged", "--stat"]).await
}

pub async fn stage_paths(dir: &Path, rel_paths: &[String]) -> Result<(), String> {
    if rel_paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "--"];
    args.extend(rel_paths.iter().map(|s| s.as_str()));
    run_git(dir, &args).await?;
    Ok(())
}

pub async fn stage_all(dir: &Path) -> Result<(), String> {
    run_git(dir, &["add", "-A"]).await?;
    Ok(())
}

pub async fn unstage_paths(dir: &Path, rel_paths: &[String]) -> Result<(), String> {
    if rel_paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(rel_paths.iter().map(|s| s.as_str()));
    run_git(dir, &args).await?;
    Ok(())
}

pub async fn unstage_all(dir: &Path) -> Result<(), String> {
    run_git(dir, &["restore", "--staged", "."]).await?;
    Ok(())
}

/// Same contract as `run_git`, but pipes `stdin` to the child process
/// rather than relying only on `args` — `git apply` reads its patch from
/// stdin here (`stage_hunk` below) rather than a temp file, so the patch
/// text never touches disk.
async fn run_git_with_stdin(dir: &Path, args: &[&str], stdin: &str) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .hide_window()
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;

    child
        .stdin
        .take()
        .expect("stdin was piped")
        .write_all(stdin.as_bytes())
        .await
        .map_err(|e| format!("failed to write git stdin: {e}"))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parses a `git diff`'s hunk header (`@@ -oldStart[,oldLines]
/// +newStart[,newLines] @@ ...`) into the "new" (`+`) side's 1-based,
/// inclusive `[start, end]` line range — a hunk that only removes lines
/// (`newLines == 0`) has no real range, but still needs a single
/// reference line for overlap matching against Monaco's own
/// `ILineChange`, which uses the same all-zero-length convention.
fn parse_hunk_new_range(header_line: &str) -> Option<(u32, u32)> {
    let rest = header_line.strip_prefix("@@ -")?;
    let plus = rest.find('+')?;
    let new_part = rest[plus + 1..].split(" @@").next()?;
    let mut parts = new_part.splitn(2, ',');
    let start: u32 = parts.next()?.trim().parse().ok()?;
    let len: u32 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1);
    let end = if len == 0 { start } else { start + len - 1 };
    Some((start, end))
}

/// Splits a single-file unified diff into its header (`diff --git`/
/// `index`/`---`/`+++` lines) and each `@@ ...@@`-delimited hunk block,
/// tagged with the hunk's "new"-side range for `stage_hunk` to match
/// against.
fn split_diff_hunks(diff_text: &str) -> (String, Vec<(u32, u32, String)>) {
    let mut header_lines = Vec::new();
    let mut hunks: Vec<(u32, u32, String)> = Vec::new();
    let mut current: Option<(u32, u32, Vec<&str>)> = None;
    let mut in_header = true;

    for line in diff_text.lines() {
        if line.starts_with("@@ ") {
            if let Some((start, end, body)) = current.take() {
                hunks.push((start, end, format!("{}\n", body.join("\n"))));
            }
            in_header = false;
            if let Some((start, end)) = parse_hunk_new_range(line) {
                current = Some((start, end, vec![line]));
            }
            continue;
        }
        if in_header {
            header_lines.push(line);
        } else if let Some((_, _, body)) = current.as_mut() {
            body.push(line);
        }
    }
    if let Some((start, end, body)) = current.take() {
        hunks.push((start, end, format!("{}\n", body.join("\n"))));
    }
    (format!("{}\n", header_lines.join("\n")), hunks)
}

/// Stages (or unstages) exactly one hunk of `rel_path`'s current diff —
/// the backend half of `MonacoDiffHost`'s per-hunk Stage/Unstage button.
/// `new_start`/`new_end` identify the hunk by its "new"-side line range,
/// as reported by Monaco's own `getLineChanges()` for whichever hunk the
/// cursor is in; the two sides agree on this numbering because the diff
/// editor's two models *are* exactly the two sides `git diff`(`--cached`)
/// itself would compare (see `diff_unstaged`/`diff_staged` above).
///
/// Recomputes the diff fresh on every call rather than trusting a hunk
/// index the frontend cached earlier — the small race against a
/// concurrent edit is the same one any hunk-staging UI (`git add -p`
/// included) accepts, and re-deriving from the range is what makes a
/// stale index harmless instead of silently staging the wrong hunk.
pub async fn stage_hunk(
    dir: &Path,
    rel_path: &str,
    unstage: bool,
    new_start: u32,
    new_end: u32,
) -> Result<(), String> {
    let diff_args: &[&str] = if unstage {
        &["diff", "--unified=3", "--cached", "--", rel_path]
    } else {
        &["diff", "--unified=3", "--", rel_path]
    };
    let diff_text = run_git(dir, diff_args).await?;
    let (header, hunks) = split_diff_hunks(&diff_text);

    let target = hunks
        .iter()
        .find(|(start, end, _)| *start <= new_end && *end >= new_start)
        .ok_or_else(|| "That change no longer matches the current diff — try again.".to_string())?;

    let patch = format!("{header}{}", target.2);
    let apply_args: &[&str] = if unstage {
        &["apply", "--cached", "--reverse", "-"]
    } else {
        &["apply", "--cached", "-"]
    };
    run_git_with_stdin(dir, apply_args, &patch).await?;
    Ok(())
}

/// Discards unstaged changes to *tracked* files, in one `git restore` for
/// the whole set rather than a process per path — "Discard all changes"
/// over a large working tree stays a single round trip. `git restore` is a
/// no-op for untracked paths (there's nothing checked-in to restore from)
/// — the command layer checks `working_status` first and deletes those
/// directly, reusing `fs_ops::safe_join` rather than this function.
pub async fn discard_unstaged_paths(dir: &Path, rel_paths: &[String]) -> Result<(), String> {
    if rel_paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["restore", "--"];
    args.extend(rel_paths.iter().map(|s| s.as_str()));
    run_git(dir, &args).await?;
    Ok(())
}

/// Commits currently-staged changes, returning the new HEAD's short hash.
pub async fn commit(dir: &Path, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message must not be empty".to_string());
    }
    run_git(dir, &["commit", "-m", message]).await?;
    let hash = run_git(dir, &["rev-parse", "--short", "HEAD"]).await?;
    Ok(hash.trim().to_string())
}

async fn current_branch(dir: &Path) -> Result<String, String> {
    let out = run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    Ok(out.trim().to_string())
}

/// The first configured remote, or an error if there isn't one — used as
/// the "which remote" guess when auto-wiring upstream tracking below.
/// Almost every repo has exactly one remote (`origin`), and this avoids
/// hardcoding that name for the (rarer) repo that renamed or added a
/// second one.
async fn default_remote(dir: &Path) -> Result<String, String> {
    let out = run_git(dir, &["remote"]).await?;
    out.lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "no git remote configured".to_string())
}

/// Every worktree's branch starts with no upstream configured (`git
/// worktree add -b` never wires one up — see `commands/worktrees.rs`), so
/// a plain `git push` on a brand-new branch always fails with "no
/// upstream branch" until the user runs `--set-upstream` manually once.
/// Retrying with `--set-upstream <remote> <branch>` on exactly that
/// failure makes the first push from a new worktree just work, the same
/// way `git push -u` would, without silently changing behavior for repos
/// that already track a remote branch (the plain `push` still runs first
/// and is enough for that common case).
pub async fn push(dir: &Path) -> Result<(), String> {
    match run_git(dir, &["push"]).await {
        Ok(_) => Ok(()),
        Err(err) if err.contains("has no upstream branch") => {
            let branch = current_branch(dir).await?;
            let remote = default_remote(dir).await.map_err(|_| err.clone())?;
            run_git(dir, &["push", "--set-upstream", &remote, &branch]).await?;
            Ok(())
        }
        Err(err) => Err(err),
    }
}

/// Fast-forward only — never silently creates a merge commit. A diverged
/// history surfaces as an `Err` for the caller to show, not to resolve.
///
/// Same upstream gap as `push` above, but pull can only wire tracking up
/// if the remote actually already has a branch of this name (there being
/// nothing to fast-forward from a branch that doesn't exist remotely is a
/// real error, not a one-time setup step to paper over).
pub async fn pull(dir: &Path) -> Result<(), String> {
    match run_git(dir, &["pull", "--ff-only"]).await {
        Ok(_) => Ok(()),
        Err(err) if err.contains("no tracking information") => {
            let branch = current_branch(dir).await?;
            let remote = default_remote(dir).await.map_err(|_| err.clone())?;
            run_git(dir, &["fetch", &remote]).await?;
            let remote_ref = format!("{remote}/{branch}");
            if run_git(dir, &["rev-parse", "--verify", &remote_ref])
                .await
                .is_err()
            {
                return Err(err);
            }
            run_git(dir, &["branch", "--set-upstream-to", &remote_ref, &branch]).await?;
            run_git(dir, &["pull", "--ff-only"]).await?;
            Ok(())
        }
        Err(err) => Err(err),
    }
}

pub async fn fetch(dir: &Path) -> Result<(), String> {
    run_git(dir, &["fetch"]).await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffMode {
    Unstaged,
    Staged,
    Commit,
}

// `rename_all` on the enum itself only renames the variant tags ("Text" ->
// "text"), not the fields of a struct-like variant — each variant needs
// its own `rename_all` for that (confirmed via a serde_json round-trip:
// without this, fields serialized as `old_text`/`new_text` instead of the
// camelCase the frontend's `DiffContent` type expects).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffContent {
    #[serde(rename_all = "camelCase")]
    Text {
        old_text: String,
        new_text: String,
        old_label: String,
        new_label: String,
        added: u32,
        removed: u32,
    },
    #[serde(rename_all = "camelCase")]
    Binary {
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    /// An untracked path git reports as a single opaque entry because it's
    /// a repository boundary it won't descend into — most commonly a
    /// nested `git worktree` checkout (this project's own worktree
    /// directories can end up here) or a submodule. `--untracked-files=all`
    /// doesn't expand these; there's no file content to diff, only a
    /// directory, so reading it as a file fails with "Is a directory".
    Directory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictContent {
    pub path: String,
    pub base_text: String,
    pub current_text: String,
    pub incoming_text: String,
    pub result_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub reference: String,
    pub hash: String,
    pub message: String,
    pub timestamp: String,
}

/// The well-known empty-tree object — diffing a root commit (no parent)
/// against this instead of `<hash>^` avoids erroring on the very first
/// commit in a repo's history.
const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

enum NumstatEntry {
    Text { added: u32, removed: u32 },
    Binary,
}

fn parse_numstat(out: &str) -> Option<NumstatEntry> {
    let line = out.lines().next()?;
    let mut parts = line.splitn(3, '\t');
    let added = parts.next()?;
    let removed = parts.next()?;
    if added == "-" && removed == "-" {
        return Some(NumstatEntry::Binary);
    }
    Some(NumstatEntry::Text {
        added: added.parse().ok()?,
        removed: removed.parse().ok()?,
    })
}

/// `git show <spec>` for a blob, treating "path doesn't exist in that
/// tree" (the normal added/deleted case, not a real failure) as an empty
/// string rather than propagating it as an error.
async fn show_blob(dir: &Path, spec: &str) -> String {
    run_git(dir, &["show", spec]).await.unwrap_or_default()
}

async fn blob_size(dir: &Path, spec: &str) -> Option<u64> {
    run_git(dir, &["cat-file", "-s", spec])
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn short(hash: &str) -> String {
    hash.chars().take(7).collect()
}

async fn diff_unstaged(dir: &Path, rel_path: &str) -> Result<DiffContent, String> {
    let numstat_out = run_git(dir, &["diff", "--numstat", "--", rel_path])
        .await
        .unwrap_or_default();

    match parse_numstat(&numstat_out) {
        Some(NumstatEntry::Binary) => {
            let old_size = blob_size(dir, &format!(":{rel_path}")).await;
            let new_size = tokio::fs::metadata(dir.join(rel_path))
                .await
                .ok()
                .map(|m| m.len());
            Ok(DiffContent::Binary { old_size, new_size })
        }
        Some(NumstatEntry::Text { added, removed }) => {
            let old_text = show_blob(dir, &format!(":{rel_path}")).await;
            let new_text = tokio::fs::read_to_string(dir.join(rel_path))
                .await
                .unwrap_or_default();
            Ok(DiffContent::Text {
                old_text,
                new_text,
                old_label: "Index".to_string(),
                new_label: "Working Tree".to_string(),
                added,
                removed,
            })
        }
        None => {
            // No unstaged diff recorded — either untracked, or genuinely
            // unchanged. `git diff --numstat` is silent for untracked
            // paths, so distinguish via `ls-files`.
            let tracked = run_git(dir, &["ls-files", "--error-unmatch", "--", rel_path])
                .await
                .is_ok();
            if tracked {
                let text = show_blob(dir, &format!(":{rel_path}")).await;
                return Ok(DiffContent::Text {
                    old_text: text.clone(),
                    new_text: text,
                    old_label: "Index".to_string(),
                    new_label: "Working Tree".to_string(),
                    added: 0,
                    removed: 0,
                });
            }
            let full_path = dir.join(rel_path);
            if tokio::fs::metadata(&full_path)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
            {
                return Ok(DiffContent::Directory);
            }
            let bytes = tokio::fs::read(&full_path)
                .await
                .map_err(|e| e.to_string())?;
            if fs_ops::looks_binary(&bytes) {
                return Ok(DiffContent::Binary {
                    old_size: None,
                    new_size: Some(bytes.len() as u64),
                });
            }
            let new_text = String::from_utf8_lossy(&bytes).to_string();
            let added = new_text.lines().count() as u32;
            Ok(DiffContent::Text {
                old_text: String::new(),
                new_text,
                old_label: "Index".to_string(),
                new_label: "Working Tree".to_string(),
                added,
                removed: 0,
            })
        }
    }
}

async fn diff_staged(dir: &Path, rel_path: &str) -> Result<DiffContent, String> {
    let numstat_out = run_git(dir, &["diff", "--numstat", "--cached", "--", rel_path])
        .await
        .unwrap_or_default();

    match parse_numstat(&numstat_out) {
        Some(NumstatEntry::Binary) => {
            let old_size = blob_size(dir, &format!("HEAD:{rel_path}")).await;
            let new_size = blob_size(dir, &format!(":{rel_path}")).await;
            Ok(DiffContent::Binary { old_size, new_size })
        }
        Some(NumstatEntry::Text { added, removed }) => {
            let old_text = show_blob(dir, &format!("HEAD:{rel_path}")).await;
            let new_text = show_blob(dir, &format!(":{rel_path}")).await;
            Ok(DiffContent::Text {
                old_text,
                new_text,
                old_label: "HEAD".to_string(),
                new_label: "Staged".to_string(),
                added,
                removed,
            })
        }
        None => {
            let text = show_blob(dir, &format!(":{rel_path}")).await;
            Ok(DiffContent::Text {
                old_text: text.clone(),
                new_text: text,
                old_label: "HEAD".to_string(),
                new_label: "Staged".to_string(),
                added: 0,
                removed: 0,
            })
        }
    }
}

async fn diff_commit(dir: &Path, rel_path: &str, hash: &str) -> Result<DiffContent, String> {
    let parent = match run_git(dir, &["rev-parse", "--verify", &format!("{hash}^")]).await {
        Ok(out) => out.trim().to_string(),
        Err(_) => EMPTY_TREE_HASH.to_string(),
    };
    let numstat_out = run_git(dir, &["diff", "--numstat", &parent, hash, "--", rel_path])
        .await
        .unwrap_or_default();
    let old_spec = format!("{parent}:{rel_path}");
    let new_spec = format!("{hash}:{rel_path}");

    match parse_numstat(&numstat_out) {
        Some(NumstatEntry::Binary) => {
            let old_size = blob_size(dir, &old_spec).await;
            let new_size = blob_size(dir, &new_spec).await;
            Ok(DiffContent::Binary { old_size, new_size })
        }
        Some(NumstatEntry::Text { added, removed }) => {
            let old_text = show_blob(dir, &old_spec).await;
            let new_text = show_blob(dir, &new_spec).await;
            Ok(DiffContent::Text {
                old_text,
                new_text,
                old_label: short(&parent),
                new_label: short(hash),
                added,
                removed,
            })
        }
        None => {
            let text = show_blob(dir, &new_spec).await;
            Ok(DiffContent::Text {
                old_text: text.clone(),
                new_text: text,
                old_label: short(&parent),
                new_label: short(hash),
                added: 0,
                removed: 0,
            })
        }
    }
}

pub async fn diff_content(
    dir: &Path,
    rel_path: &str,
    mode: DiffMode,
    commit_hash: Option<&str>,
) -> Result<DiffContent, String> {
    match mode {
        DiffMode::Unstaged => diff_unstaged(dir, rel_path).await,
        DiffMode::Staged => diff_staged(dir, rel_path).await,
        DiffMode::Commit => {
            let hash = commit_hash.ok_or("commit_hash required for Commit diff mode")?;
            diff_commit(dir, rel_path, hash).await
        }
    }
}

pub async fn conflict_content(dir: &Path, rel_path: &str) -> Result<ConflictContent, String> {
    let status = working_status(dir).await?;
    let conflicted = status.entries.iter().any(|entry| {
        entry.path == rel_path && matches!(entry.staged, Some(StatusKind::Conflicted { .. }))
    });
    if !conflicted {
        return Err(format!("{rel_path} is not an unresolved merge conflict"));
    }

    let result_text = tokio::fs::read_to_string(dir.join(rel_path))
        .await
        .unwrap_or_default();
    Ok(ConflictContent {
        path: rel_path.to_string(),
        base_text: show_blob(dir, &format!(":1:{rel_path}")).await,
        current_text: show_blob(dir, &format!(":2:{rel_path}")).await,
        incoming_text: show_blob(dir, &format!(":3:{rel_path}")).await,
        result_text,
    })
}

pub async fn resolve_conflict(dir: &Path, rel_path: &str, result: &str) -> Result<(), String> {
    let path = fs_ops::safe_join(dir, rel_path)?;
    tokio::fs::write(path, result)
        .await
        .map_err(|e| e.to_string())?;
    stage_paths(dir, &[rel_path.to_string()]).await
}

pub async fn list_stashes(dir: &Path) -> Result<Vec<StashEntry>, String> {
    let out = run_git(
        dir,
        &["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%aI%x1e"],
    )
    .await?;
    let mut entries = Vec::new();
    for record in out.split('\u{1e}') {
        let fields: Vec<&str> = record.trim_matches('\n').split('\u{1f}').collect();
        if fields.len() != 4 || fields[0].is_empty() {
            continue;
        }
        let index = fields[0]
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse()
            .unwrap_or(0);
        entries.push(StashEntry {
            index,
            reference: fields[0].to_string(),
            hash: fields[1].to_string(),
            message: fields[2].to_string(),
            timestamp: fields[3].to_string(),
        });
    }
    Ok(entries)
}

pub async fn create_stash(
    dir: &Path,
    message: &str,
    include_untracked: bool,
) -> Result<(), String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if !message.trim().is_empty() {
        args.extend(["-m", message.trim()]);
    }
    run_git(dir, &args).await?;
    Ok(())
}

pub async fn apply_stash(dir: &Path, reference: &str, pop: bool) -> Result<(), String> {
    run_git(
        dir,
        &[
            "stash",
            if pop { "pop" } else { "apply" },
            "--index",
            reference,
        ],
    )
    .await?;
    Ok(())
}

pub async fn drop_stash(dir: &Path, reference: &str) -> Result<(), String> {
    run_git(dir, &["stash", "drop", reference]).await?;
    Ok(())
}

pub async fn stash_files(dir: &Path, reference: &str) -> Result<Vec<(String, StatusKind)>, String> {
    let parent = format!("{reference}^");
    let out = run_git(dir, &["diff", "--name-status", &parent, reference]).await?;
    parse_name_status(&out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub author_email: String,
    /// RFC3339, straight from `%aI` — no `chrono` parsing needed on this side.
    pub timestamp: String,
    pub message: String,
}

/// Paginated commit log, newest first. Uses unit/record separator control
/// characters (`\x1f`/`\x1e`) as delimiters rather than a printable one
/// like `|`, since commit subjects can legitimately contain any printable
/// character. An empty/unborn-HEAD repo (no commits yet) returns an empty
/// list rather than propagating `git log`'s error.
pub async fn log(dir: &Path, limit: u32, skip: u32) -> Result<Vec<CommitSummary>, String> {
    let format = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";
    let out = match run_git(
        dir,
        &[
            "log",
            &format!("--format={format}"),
            "-n",
            &limit.to_string(),
            "--skip",
            &skip.to_string(),
        ],
    )
    .await
    {
        Ok(out) => out,
        Err(_) => return Ok(Vec::new()),
    };

    let mut commits = Vec::new();
    for record in out.split('\u{1e}') {
        let record = record.trim_matches('\n');
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\u{1f}').collect();
        if fields.len() != 6 {
            continue;
        }
        commits.push(CommitSummary {
            hash: fields[0].to_string(),
            short_hash: fields[1].to_string(),
            author: fields[2].to_string(),
            author_email: fields[3].to_string(),
            timestamp: fields[4].to_string(),
            message: fields[5].to_string(),
        });
    }
    Ok(commits)
}

/// Files changed by a single commit, via `--name-status` (not `--numstat`
/// — this is the form that actually reports Added/Deleted/Renamed/Copied
/// distinctly, which `commit_files` needs and `diff_content`'s numstat use
/// doesn't).
pub async fn commit_files(dir: &Path, hash: &str) -> Result<Vec<(String, StatusKind)>, String> {
    let out = run_git(dir, &["show", "--name-status", "--format=", hash]).await?;
    parse_name_status(&out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based, matching Monaco's own line numbering.
    pub line: u32,
    /// All-zero for a working-tree line with no commit yet (git's own
    /// convention — `author` reads "Not Committed Yet" for these).
    pub hash: String,
    pub author: String,
    /// Unix seconds (`author-time`, as git reports it) — left as a raw
    /// epoch rather than formatted here since the frontend already has
    /// its own relative-time formatter (`design/relativeTime.ts`) that
    /// every other commit timestamp in the app goes through.
    pub author_time: i64,
    pub summary: String,
}

fn is_commit_hash(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Blames the file as it currently sits in the working tree (uncommitted
/// edits included, reported against the special all-zero hash) via
/// `--line-porcelain` — verbose (full commit metadata repeated for every
/// single line rather than once per contiguous run) but trivial to parse
/// correctly, and this only runs once per file open/save rather than per
/// keystroke, so the extra output size isn't a real cost.
pub async fn blame(dir: &Path, rel_path: &str) -> Result<Vec<BlameLine>, String> {
    let out = run_git(dir, &["blame", "--line-porcelain", "--", rel_path]).await?;

    let mut result = Vec::new();
    let mut hash = String::new();
    let mut final_line: u32 = 0;
    let mut author = String::new();
    let mut author_time: i64 = 0;
    let mut summary = String::new();

    for line in out.lines() {
        if let Some((maybe_hash, rest)) = line.split_once(' ') {
            if is_commit_hash(maybe_hash) {
                // "<hash> <orig-line> <final-line>[ <group-size>]"
                if let Some(final_str) = rest.trim_start().split_whitespace().nth(1) {
                    if let Ok(fl) = final_str.parse::<u32>() {
                        hash = maybe_hash.to_string();
                        final_line = fl;
                    }
                }
                continue;
            }
        }
        if let Some(v) = line.strip_prefix("author ") {
            author = v.to_string();
        } else if let Some(v) = line.strip_prefix("author-time ") {
            author_time = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("summary ") {
            summary = v.to_string();
        } else if line.starts_with('\t') {
            result.push(BlameLine {
                line: final_line,
                hash: hash.clone(),
                author: author.clone(),
                author_time,
                summary: summary.clone(),
            });
        }
    }

    Ok(result)
}

fn parse_name_status(out: &str) -> Result<Vec<(String, StatusKind)>, String> {
    let mut files = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let code = fields[0];
        let kind_char = code.chars().next().unwrap_or('M');
        let path = match kind_char {
            'R' | 'C' => fields.get(2).or(fields.get(1)).copied(),
            _ => fields.get(1).copied(),
        }
        .unwrap_or("")
        .to_string();
        if path.is_empty() {
            continue;
        }
        let kind = match kind_char {
            'A' => StatusKind::Added,
            'D' => StatusKind::Deleted,
            'T' => StatusKind::TypeChanged,
            'R' => StatusKind::Renamed {
                similarity: code[1..].parse().unwrap_or(0),
            },
            'C' => StatusKind::Copied {
                similarity: code[1..].parse().unwrap_or(0),
            },
            _ => StatusKind::Modified,
        };
        files.push((path, kind));
    }
    Ok(files)
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

    #[tokio::test]
    async fn status_map_reflects_modified_added_and_untracked_files() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "changed").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new").unwrap();
        run_git(dir.path(), &["add", "new.txt"]).await.unwrap();
        std::fs::write(dir.path().join("scratch.txt"), "untracked").unwrap();

        let map = status_map(dir.path()).await.unwrap();
        assert_eq!(map.get("README.md"), Some(&'M'));
        assert_eq!(map.get("new.txt"), Some(&'A'));
        assert_eq!(map.get("scratch.txt"), Some(&'U'));
    }

    #[tokio::test]
    async fn working_status_detects_rename() {
        let dir = init_repo().await;
        run_git(dir.path(), &["mv", "README.md", "GUIDE.md"])
            .await
            .unwrap();

        let status = working_status(dir.path()).await.unwrap();
        let entry = status
            .entries
            .iter()
            .find(|e| e.path == "GUIDE.md")
            .unwrap();
        assert_eq!(entry.old_path.as_deref(), Some("README.md"));
        assert!(matches!(entry.staged, Some(StatusKind::Renamed { .. })));

        let map = status_map(dir.path()).await.unwrap();
        assert_eq!(map.get("GUIDE.md"), Some(&'A'));
    }

    #[tokio::test]
    async fn working_status_detects_partially_staged_file() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "staged change").unwrap();
        run_git(dir.path(), &["add", "README.md"]).await.unwrap();
        std::fs::write(dir.path().join("README.md"), "staged change\nplus more").unwrap();

        let status = working_status(dir.path()).await.unwrap();
        let entry = status
            .entries
            .iter()
            .find(|e| e.path == "README.md")
            .unwrap();
        assert!(matches!(entry.staged, Some(StatusKind::Modified)));
        assert!(matches!(entry.unstaged, Some(StatusKind::Modified)));
    }

    #[tokio::test]
    async fn working_status_flags_conflicts_distinctly() {
        let dir = init_repo().await;
        run_git(dir.path(), &["checkout", "-b", "feature"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("README.md"), "feature version").unwrap();
        run_git(dir.path(), &["commit", "-am", "feature edit"])
            .await
            .unwrap();

        run_git(dir.path(), &["checkout", "main"]).await.unwrap();
        std::fs::write(dir.path().join("README.md"), "main version").unwrap();
        run_git(dir.path(), &["commit", "-am", "main edit"])
            .await
            .unwrap();

        // Expected to fail with a merge conflict — the failure itself is
        // what this test is exercising, not a real error to propagate.
        let _ = run_git(dir.path(), &["merge", "feature"]).await;

        let status = working_status(dir.path()).await.unwrap();
        let entry = status
            .entries
            .iter()
            .find(|e| e.path == "README.md")
            .unwrap();
        assert!(matches!(entry.staged, Some(StatusKind::Conflicted { .. })));

        let map = status_map(dir.path()).await.unwrap();
        assert_eq!(map.get("README.md"), Some(&'C'));

        let content = conflict_content(dir.path(), "README.md").await.unwrap();
        assert_eq!(content.current_text, "main version");
        assert_eq!(content.incoming_text, "feature version");
        assert!(content.result_text.contains("<<<<<<<"));

        resolve_conflict(dir.path(), "README.md", "combined version")
            .await
            .unwrap();
        let status = working_status(dir.path()).await.unwrap();
        assert!(!status
            .entries
            .iter()
            .any(|entry| matches!(entry.staged, Some(StatusKind::Conflicted { .. }))));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "combined version"
        );
    }

    #[tokio::test]
    async fn stash_create_list_review_apply_and_drop_round_trip() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "stashed edit").unwrap();
        create_stash(dir.path(), "work in progress", true)
            .await
            .unwrap();
        assert!(!is_dirty(dir.path()).await);

        let entries = list_stashes(dir.path()).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].message.contains("work in progress"));
        let files = stash_files(dir.path(), &entries[0].reference)
            .await
            .unwrap();
        assert!(files.iter().any(|(path, _)| path == "README.md"));

        apply_stash(dir.path(), &entries[0].reference, false)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "stashed edit"
        );
        run_git(dir.path(), &["restore", "README.md"])
            .await
            .unwrap();
        drop_stash(dir.path(), &entries[0].reference).await.unwrap();
        assert!(list_stashes(dir.path()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stage_unstage_and_commit_round_trip() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("scratch.txt"), "x").unwrap();

        stage_paths(dir.path(), &["scratch.txt".to_string()])
            .await
            .unwrap();
        let status = working_status(dir.path()).await.unwrap();
        assert!(matches!(
            status
                .entries
                .iter()
                .find(|e| e.path == "scratch.txt")
                .unwrap()
                .staged,
            Some(StatusKind::Added)
        ));

        unstage_paths(dir.path(), &["scratch.txt".to_string()])
            .await
            .unwrap();
        let status = working_status(dir.path()).await.unwrap();
        assert!(status
            .entries
            .iter()
            .find(|e| e.path == "scratch.txt")
            .unwrap()
            .staged
            .is_none());

        stage_all(dir.path()).await.unwrap();
        let hash = commit(dir.path(), "add scratch").await.unwrap();
        assert!(!hash.is_empty());

        let status = working_status(dir.path()).await.unwrap();
        assert!(status.entries.is_empty());
    }

    #[tokio::test]
    async fn commit_rejects_empty_message() {
        let dir = init_repo().await;
        assert!(commit(dir.path(), "   ").await.is_err());
    }

    #[tokio::test]
    async fn discard_unstaged_reverts_tracked_file() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "changed").unwrap();
        discard_unstaged_paths(dir.path(), &["README.md".to_string()])
            .await
            .unwrap();
        assert!(!is_dirty(dir.path()).await);
    }

    #[tokio::test]
    async fn discard_unstaged_paths_reverts_every_listed_file() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        stage_all(dir.path()).await.unwrap();
        commit(dir.path(), "add a and b").await.unwrap();

        std::fs::write(dir.path().join("a.txt"), "a changed").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b changed").unwrap();
        discard_unstaged_paths(dir.path(), &["a.txt".to_string(), "b.txt".to_string()])
            .await
            .unwrap();

        assert!(!is_dirty(dir.path()).await);
    }

    #[tokio::test]
    async fn discard_unstaged_paths_is_a_noop_for_an_empty_list() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "changed").unwrap();
        discard_unstaged_paths(dir.path(), &[]).await.unwrap();
        // Nothing was named, so nothing is reverted.
        assert!(is_dirty(dir.path()).await);
    }

    #[tokio::test]
    async fn diff_content_unstaged_text_matches_working_tree() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "hello\nworld").unwrap();
        let diff = diff_content(dir.path(), "README.md", DiffMode::Unstaged, None)
            .await
            .unwrap();
        match diff {
            DiffContent::Text {
                old_text, new_text, ..
            } => {
                assert_eq!(old_text, "hello");
                assert_eq!(new_text, "hello\nworld");
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn diff_content_staged_text_matches_index() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("README.md"), "staged content").unwrap();
        run_git(dir.path(), &["add", "README.md"]).await.unwrap();

        let diff = diff_content(dir.path(), "README.md", DiffMode::Staged, None)
            .await
            .unwrap();
        match diff {
            DiffContent::Text {
                old_text, new_text, ..
            } => {
                assert_eq!(old_text, "hello");
                assert_eq!(new_text, "staged content");
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn diff_content_detects_binary_file() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        run_git(dir.path(), &["add", "bin.dat"]).await.unwrap();
        let diff = diff_content(dir.path(), "bin.dat", DiffMode::Staged, None)
            .await
            .unwrap();
        assert!(matches!(diff, DiffContent::Binary { .. }));
    }

    #[tokio::test]
    async fn diff_content_detects_untracked_binary_file_via_sniff_fallback() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("scratch.bin"), [0u8, 1, 2, 3]).unwrap();
        let diff = diff_content(dir.path(), "scratch.bin", DiffMode::Unstaged, None)
            .await
            .unwrap();
        assert!(matches!(diff, DiffContent::Binary { .. }));
    }

    #[tokio::test]
    async fn diff_content_commit_mode_handles_root_commit() {
        let dir = init_repo().await;
        let hash = run_git(dir.path(), &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .trim()
            .to_string();
        let diff = diff_content(dir.path(), "README.md", DiffMode::Commit, Some(&hash))
            .await
            .unwrap();
        match diff {
            DiffContent::Text {
                old_text, new_text, ..
            } => {
                assert_eq!(old_text, "");
                assert_eq!(new_text, "hello");
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn log_and_commit_files_reflect_history() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        run_git(dir.path(), &["add", "a.txt"]).await.unwrap();
        run_git(dir.path(), &["commit", "-m", "add a"])
            .await
            .unwrap();

        let commits = log(dir.path(), 10, 0).await.unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].message, "add a");

        let files = commit_files(dir.path(), &commits[0].hash).await.unwrap();
        assert!(files
            .iter()
            .any(|(p, k)| p == "a.txt" && matches!(k, StatusKind::Added)));
    }

    #[tokio::test]
    async fn log_returns_empty_for_unborn_head() {
        let dir = TempDir::new().unwrap();
        run_git(dir.path(), &["init", "-b", "main"]).await.unwrap();
        let commits = log(dir.path(), 10, 0).await.unwrap();
        assert!(commits.is_empty());
    }

    /// Two far-apart edits in the same file, so `--unified=3` reports them
    /// as two separate hunks rather than merging them into one.
    async fn write_two_hunk_file(dir: &Path) {
        let lines: Vec<String> = (1..=20).map(|n| format!("line{n}")).collect();
        std::fs::write(dir.join("multi.txt"), lines.join("\n") + "\n").unwrap();
        run_git(dir, &["add", "multi.txt"]).await.unwrap();
        run_git(dir, &["commit", "-m", "add multi.txt"])
            .await
            .unwrap();

        let mut edited = lines;
        edited[1] = "line2-changed".to_string(); // hunk near line 2
        edited[17] = "line18-changed".to_string(); // hunk near line 18
        std::fs::write(dir.join("multi.txt"), edited.join("\n") + "\n").unwrap();
    }

    #[tokio::test]
    async fn stages_a_single_hunk_leaving_the_other_unstaged() {
        let dir = init_repo().await;
        write_two_hunk_file(dir.path()).await;

        // The range only overlaps the hunk touching line 18.
        stage_hunk(dir.path(), "multi.txt", false, 18, 18)
            .await
            .unwrap();

        let staged = run_git(dir.path(), &["diff", "--cached", "--", "multi.txt"])
            .await
            .unwrap();
        assert!(staged.contains("+line18-changed"));
        assert!(!staged.contains("line2-changed"));

        let unstaged = run_git(dir.path(), &["diff", "--", "multi.txt"])
            .await
            .unwrap();
        assert!(unstaged.contains("+line2-changed"));
        assert!(!unstaged.contains("line18-changed"));
    }

    #[tokio::test]
    async fn unstages_a_single_hunk_leaving_the_other_staged() {
        let dir = init_repo().await;
        write_two_hunk_file(dir.path()).await;
        stage_paths(dir.path(), &["multi.txt".to_string()])
            .await
            .unwrap();

        // The range only overlaps the hunk touching line 2.
        stage_hunk(dir.path(), "multi.txt", true, 2, 2)
            .await
            .unwrap();

        let staged = run_git(dir.path(), &["diff", "--cached", "--", "multi.txt"])
            .await
            .unwrap();
        assert!(staged.contains("+line18-changed"));
        assert!(!staged.contains("line2-changed"));

        let unstaged = run_git(dir.path(), &["diff", "--", "multi.txt"])
            .await
            .unwrap();
        assert!(unstaged.contains("+line2-changed"));
        assert!(!unstaged.contains("line18-changed"));
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
