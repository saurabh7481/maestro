//! The three git operations that talk to a server — `fetch`, `pull`,
//! `push` — plus the error vocabulary the Source Control UI renders.
//!
//! Split out of `git.rs` because remote operations are the only ones with
//! failure modes a user has to *act* on: everything local either succeeds
//! or is a programming error, whereas a push can be rejected, an
//! authentication can lapse, a pull can be blocked by the working tree,
//! and each of those has a different, specific next step. Returning a raw
//! `String` of git's stderr (what this code used to do) makes every one
//! of them look the same to the frontend, which is why the SCM panel
//! could only ever dump the stderr verbatim into a red box.
//!
//! Two problems are solved here:
//!
//! 1. **Hangs.** A remote git invocation is the only kind that can block
//!    forever: on a credential prompt with nowhere to prompt, on an
//!    unreachable host, on an `ssh` passphrase read from a tty the GUI
//!    may or may not have. `run_remote_git` closes stdin, disables git's
//!    terminal prompt, and enforces a hard timeout so a stuck operation
//!    surfaces as an error the user can see instead of a spinner that
//!    never stops.
//! 2. **Legibility.** [`classify`] turns git's stderr into a
//!    [`GitRemoteError`] with a short title, a plain-language
//!    explanation, the file paths git named as blockers, the raw output
//!    (kept, never discarded — it goes behind a disclosure in the UI),
//!    and the concrete remedies that apply, which the panel renders as
//!    buttons.

use crate::git::{current_branch, run_git};
use crate::process_ext::HiddenCommandExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// Long enough for a cold clone-sized fetch over a slow link, short
/// enough that a wedged process (credential prompt on a build with no
/// tty, black-holed TCP connection) still reports back within a couple of
/// minutes rather than pinning the button in its spinner state forever.
const REMOTE_OP_TIMEOUT: Duration = Duration::from_secs(120);

/// Marks stashes this module creates on the user's behalf so an
/// interrupted stash/pull/pop cycle leaves something self-explanatory in
/// `git stash list` rather than an anonymous "WIP on ...".
const AUTO_STASH_MESSAGE: &str = "maestro: auto-stash before pull";

/// Which operation produced an error — the same git message means
/// different things ("fetch first" is advice on push, a symptom on pull),
/// and the remedies differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteOp {
    Fetch,
    Pull,
    Push,
}

impl RemoteOp {
    fn noun(self) -> &'static str {
        match self {
            RemoteOp::Fetch => "Fetch",
            RemoteOp::Pull => "Pull",
            RemoteOp::Push => "Push",
        }
    }
}

/// The machine-readable half of a failure. The frontend switches on this
/// for iconography and for which of `actions` it knows how to run; it
/// never parses `title`/`message`/`detail`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitErrorCode {
    NoRemote,
    NoRemoteBranch,
    AuthFailed,
    HostKey,
    Network,
    RepositoryNotFound,
    DirtyWorkingTree,
    UntrackedOverwrite,
    Diverged,
    MergeConflict,
    Rejected,
    HookRejected,
    OperationInProgress,
    DetachedHead,
    UnbornBranch,
    ForcePushStale,
    Locked,
    TimedOut,
    Unknown,
}

/// A remedy the Source Control panel offers as a button. Kept to things
/// the app can actually carry out itself — "commit your changes first" is
/// advice and belongs in `message`, not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitErrorAction {
    /// Stash (including untracked files), pull, then restore the stash.
    StashAndPull,
    /// `git pull --rebase --autostash` — replay local commits on top.
    RebasePull,
    /// `git pull --no-rebase` — a merge commit, conflicts and all.
    MergePull,
    /// Fast-forward first, then retry the push.
    PullThenPush,
    /// `git push --force-with-lease`.
    ForcePush,
    /// Same operation, same options, again.
    Retry,
}

/// Everything the UI needs to present a failed remote operation the way a
/// mature git client does: a headline, a sentence of explanation, the
/// blocking paths when git named any, the untouched raw output, and the
/// available remedies.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteError {
    pub code: GitErrorCode,
    /// Short headline, already scoped to the operation ("Pull blocked by
    /// local changes"). Safe to render on one line.
    pub title: String,
    /// One or two plain sentences: what happened, and what to do about it.
    pub message: String,
    /// Git's own stdout+stderr, verbatim. Always populated (possibly with
    /// a synthesized line for non-git failures) and never shown by
    /// default — the panel puts it behind "Show details".
    pub detail: String,
    /// Paths git listed as blockers, in git's order. Empty for errors
    /// that aren't about specific files.
    pub paths: Vec<String>,
    /// Remedies, most-recommended first.
    pub actions: Vec<GitErrorAction>,
}

impl GitRemoteError {
    /// For failures that never reached git's network layer — a missing
    /// remote, a helper command that failed, a spawn error. `detail`
    /// carries whatever context there was so nothing is swallowed.
    fn simple(code: GitErrorCode, title: &str, message: &str, detail: String) -> Self {
        GitRemoteError {
            code,
            title: title.to_string(),
            message: message.to_string(),
            detail,
            paths: Vec::new(),
            actions: Vec::new(),
        }
    }
}

/// A local (non-networked) git helper failing mid-operation still has to
/// reach the UI as a structured error, not a bare string.
fn local_failure(op: RemoteOp, detail: String) -> GitRemoteError {
    classify(op, &detail, false)
}

// ---------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------

struct RemoteFailure {
    /// stdout and stderr concatenated: git splits its reporting across
    /// both (a rejected push prints the ref table on stderr but the
    /// remote's own `remote:` lines can land on either), and every
    /// consumer here wants the union.
    output: String,
    timed_out: bool,
}

/// Runs a git subcommand that may contact a server.
///
/// Differences from `git::run_git`, all of them about not hanging:
/// * **stdin is closed.** Inherited from a GUI process it is either
///   useless or an invitation for git to block reading from it.
/// * **`GIT_TERMINAL_PROMPT=0`.** Without it, git asks for a username on
///   the terminal — and in a windowed build there is no terminal to
///   answer on, so the process waits forever. With it, git fails fast and
///   `classify` turns that into "Authentication failed". A configured
///   askpass helper (`GIT_ASKPASS`, `core.askPass`, the OS credential
///   manager) is deliberately left alone: those *can* prompt the user
///   properly, and users who set one up rely on it.
/// * **`ssh -o ConnectTimeout`.** Only when the user hasn't set
///   `GIT_SSH_COMMAND` themselves, so an explicit ssh configuration wins.
/// * **`LC_ALL=C`.** Git translates its error text; [`classify`] matches
///   on English. Affects only messages, never paths or refs.
/// * **A wall-clock timeout**, with the child killed on the way out.
async fn run_remote_git(dir: &Path, args: &[&str]) -> Result<String, RemoteFailure> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .hide_window()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");

    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o ConnectTimeout=15");
    }

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Err(RemoteFailure {
                output: format!("failed to run git: {e}"),
                timed_out: false,
            })
        }
    };

    // `wait_with_output` takes ownership, so the timeout path drops the
    // child — and `kill_on_drop` reaps it — rather than leaving an
    // orphaned `git` holding the repo's locks.
    let output = match tokio::time::timeout(REMOTE_OP_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return Err(RemoteFailure {
                output: format!("failed to run git: {e}"),
                timed_out: false,
            })
        }
        Err(_) => {
            return Err(RemoteFailure {
                output: format!(
                    "git {} timed out after {}s",
                    args.first().copied().unwrap_or("command"),
                    REMOTE_OP_TIMEOUT.as_secs()
                ),
                timed_out: true,
            })
        }
    };

    // stdout and stderr are joined on both paths: git splits its
    // reporting across the two (a push prints "Everything up-to-date" and
    // a rejected ref table on stderr, the fetched-ref summary on stdout),
    // and every caller here wants the union rather than one half.
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let mut combined = String::new();
    for part in [stderr.trim_end(), stdout.trim_end()] {
        if part.is_empty() {
            continue;
        }
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(part);
    }

    if output.status.success() {
        return Ok(combined);
    }
    if combined.is_empty() {
        combined = format!("git exited with {}", output.status);
    }
    Err(RemoteFailure {
        output: combined,
        timed_out: false,
    })
}

// ---------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------

/// Git indents the paths it is complaining about with a tab, under a
/// heading line ("...the following files would be overwritten by
/// merge:"). Collecting every tab-indented line is enough to recover them
/// and is stable across the several headings that use the same shape.
fn indented_paths(output: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in output.lines() {
        if !(line.starts_with('\t') || line.starts_with("        ")) {
            continue;
        }
        let path = line.trim();
        // Merge/rebase summaries indent their own progress lines too;
        // those read as sentences, real paths never contain a space.
        if path.is_empty() || path.contains(' ') || paths.iter().any(|p| p == path) {
            continue;
        }
        paths.push(path.to_string());
    }
    paths
}

/// `remote:` lines are the server talking (branch protection, a
/// pre-receive hook, a PR link). When present they are the most useful
/// thing to put in front of the user.
fn remote_lines(output: &str) -> String {
    output
        .lines()
        .filter_map(|l| l.trim().strip_prefix("remote:"))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Maps raw git output onto a [`GitRemoteError`]. Ordering matters: the
/// specific patterns are tested before the generic ones they would
/// otherwise be swallowed by (a 403 says "unable to access", which also
/// matches the network bucket; a protected-branch rejection says "failed
/// to push some refs", which also matches the plain non-fast-forward
/// bucket).
pub fn classify(op: RemoteOp, output: &str, timed_out: bool) -> GitRemoteError {
    let hay = output.to_lowercase();
    let has = |needle: &str| hay.contains(needle);
    let detail = output.trim().to_string();
    let noun = op.noun();

    let build = |code: GitErrorCode, title: String, message: String, actions: &[GitErrorAction]| {
        GitRemoteError {
            code,
            title,
            message,
            detail: detail.clone(),
            paths: Vec::new(),
            actions: actions.to_vec(),
        }
    };

    if timed_out {
        return build(
            GitErrorCode::TimedOut,
            format!("{noun} timed out"),
            format!(
                "Git didn't finish within {}s. The remote may be unreachable, or git may be waiting on a credential or SSH passphrase prompt it can't show here.",
                REMOTE_OP_TIMEOUT.as_secs()
            ),
            &[GitErrorAction::Retry],
        );
    }

    if has("could not read username")
        || has("could not read password")
        || has("authentication failed")
        || has("invalid username or password")
        || has("permission denied (publickey")
        || (has("permission to ") && has("denied"))
        || has("403 forbidden")
        || has("the requested url returned error: 403")
        || has("support for password authentication was removed")
    {
        return build(
            GitErrorCode::AuthFailed,
            "Authentication failed".to_string(),
            "The remote rejected your credentials. Check that your SSH key is loaded (`ssh-add -l`) or that your saved token hasn't expired, then try again."
                .to_string(),
            &[GitErrorAction::Retry],
        );
    }

    if has("host key verification failed") || has("no matching host key") {
        return build(
            GitErrorCode::HostKey,
            "Host key not trusted".to_string(),
            "SSH doesn't recognise this server's host key. Connect to it once from a terminal (`ssh -T git@…`) to review and accept the key, then try again."
                .to_string(),
            &[GitErrorAction::Retry],
        );
    }

    if has("could not resolve host")
        || has("connection timed out")
        || has("connection refused")
        || has("network is unreachable")
        || has("could not connect")
        || has("failed to connect")
        || has("ssl certificate problem")
        || has("the remote end hung up")
        || has("early eof")
        || has("operation timed out")
    {
        return build(
            GitErrorCode::Network,
            format!("{noun} couldn't reach the remote"),
            "The connection to the remote failed. Check your network or VPN and try again."
                .to_string(),
            &[GitErrorAction::Retry],
        );
    }

    if has("repository not found") || has("does not appear to be a git repository") {
        return build(
            GitErrorCode::RepositoryNotFound,
            "Remote repository not found".to_string(),
            "The remote URL doesn't point at a repository you can see. If it's private, this usually means your credentials don't have access to it."
                .to_string(),
            &[],
        );
    }

    if has("no configured push destination") || has("no remote repository specified") {
        return build(
            GitErrorCode::NoRemote,
            "No remote configured".to_string(),
            "This repository has no remote to sync with. Add one with `git remote add origin <url>`."
                .to_string(),
            &[],
        );
    }

    // `--force-with-lease` refusing is the safety net doing its job: the
    // remote holds commits that were never fetched here, so overwriting
    // it would destroy work nobody has looked at. Deliberately offers no
    // "force anyway" button — pulling first is the answer.
    if has("stale info") {
        return build(
            GitErrorCode::ForcePushStale,
            "Force push refused — the remote has commits you've never fetched".to_string(),
            "Someone (or something) pushed to this branch since you last fetched it. Force-pushing now would delete those commits, so git refused. Pull to see them first."
                .to_string(),
            &[GitErrorAction::PullThenPush],
        );
    }

    if has("your local changes to the following files would be overwritten")
        || has("cannot pull with rebase")
        || (has("you have unstaged changes") && has("commit or stash"))
    {
        let mut err = build(
            GitErrorCode::DirtyWorkingTree,
            "Pull blocked by local changes".to_string(),
            "Pulling would overwrite files you've edited. Stash them and pull (your edits are restored afterwards), or commit them first."
                .to_string(),
            &[GitErrorAction::StashAndPull, GitErrorAction::Retry],
        );
        err.paths = indented_paths(output);
        return err;
    }

    if has("untracked working tree files would be overwritten") {
        let mut err = build(
            GitErrorCode::UntrackedOverwrite,
            "Pull blocked by untracked files".to_string(),
            "The incoming commits add files you already have locally but haven't committed. Stash them and pull (they're restored afterwards), or move them aside."
                .to_string(),
            &[GitErrorAction::StashAndPull, GitErrorAction::Retry],
        );
        err.paths = indented_paths(output);
        return err;
    }

    if has("not possible to fast-forward")
        || has("need to specify how to reconcile divergent branches")
        || has("you have divergent branches")
    {
        return build(
            GitErrorCode::Diverged,
            "Your branch and the remote have diverged".to_string(),
            "You have commits the remote doesn't, and it has commits you don't, so this can't be fast-forwarded. Rebase your commits on top of the remote's, or merge the two."
                .to_string(),
            &[GitErrorAction::RebasePull, GitErrorAction::MergePull],
        );
    }

    if has("automatic merge failed")
        || has("fix conflicts and then commit")
        || has("could not apply")
        || has("resolve all conflicts manually")
    {
        let mut err = build(
            GitErrorCode::MergeConflict,
            "Merge conflicts need resolving".to_string(),
            "The incoming changes conflict with yours. Resolve the conflicted files in Source Control, then commit to finish.".to_string(),
            &[],
        );
        err.paths = indented_paths(output);
        return err;
    }

    if has("protected branch")
        || has("pre-receive hook declined")
        || has("push declined")
        || has("hook declined")
    {
        let remote = remote_lines(output);
        return build(
            GitErrorCode::HookRejected,
            "The remote rejected this push".to_string(),
            if remote.is_empty() {
                "A server-side rule (branch protection or a pre-receive hook) refused the push."
                    .to_string()
            } else {
                format!("The server refused the push: {remote}")
            },
            &[],
        );
    }

    if has("non-fast-forward")
        || has("updates were rejected")
        || has("failed to push some refs")
        || has("fetch first")
    {
        return build(
            GitErrorCode::Rejected,
            "Push rejected — the remote moved on".to_string(),
            "The remote branch has commits you don't have locally. Pull them first, then push. Force-pushing replaces the remote's history and is only safe on a branch nobody else is using."
                .to_string(),
            &[GitErrorAction::PullThenPush, GitErrorAction::ForcePush],
        );
    }

    if has("couldn't find remote ref")
        || has("no such ref")
        || has("does not match any")
        || has("no tracking information")
        || has("has no upstream branch")
    {
        return build(
            GitErrorCode::NoRemoteBranch,
            "No matching branch on the remote".to_string(),
            match op {
                RemoteOp::Push => "The remote doesn't have this branch yet — pushing will create it.".to_string(),
                _ => "This branch doesn't exist on the remote yet, so there's nothing to pull. Push it first to create it.".to_string(),
            },
            &[],
        );
    }

    if has("index.lock") || (has("unable to create") && has(".lock")) {
        return build(
            GitErrorCode::Locked,
            "The repository is locked".to_string(),
            "Another git process is using this repository. Wait for it to finish and try again; if nothing is running, remove `.git/index.lock` manually."
                .to_string(),
            &[GitErrorAction::Retry],
        );
    }

    if has("rebase in progress")
        || has("you are in the middle of")
        || has("merge_head exists")
        || has("cherry-pick or revert in progress")
    {
        return build(
            GitErrorCode::OperationInProgress,
            "Another git operation is unfinished".to_string(),
            "This worktree is mid-merge, mid-rebase, or mid-cherry-pick. Finish or abort it before pulling again.".to_string(),
            &[],
        );
    }

    if has("not currently on a branch") || has("detached head") {
        return build(
            GitErrorCode::DetachedHead,
            "HEAD is detached".to_string(),
            "This worktree isn't on a branch, so there's nothing to sync with a remote. Check out a branch first.".to_string(),
            &[],
        );
    }

    if has("does not have any commits yet") || has("unborn") {
        return build(
            GitErrorCode::UnbornBranch,
            "This branch has no commits yet".to_string(),
            "Make a commit before syncing with the remote.".to_string(),
            &[],
        );
    }

    let remote = remote_lines(output);
    build(
        GitErrorCode::Unknown,
        format!("{noun} failed"),
        if remote.is_empty() {
            format!(
                "Git couldn't complete the {}. See the details below.",
                noun.to_lowercase()
            )
        } else {
            remote
        },
        &[GitErrorAction::Retry],
    )
}

// ---------------------------------------------------------------------
// Upstream plumbing
// ---------------------------------------------------------------------

/// The first configured remote, or an error if there isn't one — the
/// "which remote" guess when auto-wiring upstream tracking below. Almost
/// every repo has exactly one (`origin`); reading it avoids hardcoding
/// that name for the rarer repo that renamed or added a second.
async fn default_remote(dir: &Path) -> Result<String, GitRemoteError> {
    let out = run_git(dir, &["remote"]).await.map_err(|e| {
        GitRemoteError::simple(
            GitErrorCode::NoRemote,
            "No remote configured",
            "This repository has no remote to sync with. Add one with `git remote add origin <url>`.",
            e,
        )
    })?;
    out.lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            GitRemoteError::simple(
                GitErrorCode::NoRemote,
                "No remote configured",
                "This repository has no remote to sync with. Add one with `git remote add origin <url>`.",
                "git remote listed no remotes".to_string(),
            )
        })
}

async fn upstream_ref(dir: &Path) -> Option<String> {
    run_git(
        dir,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .await
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

/// Every worktree's branch starts with no upstream configured (`git
/// worktree add -b` never wires one up — see `commands/worktrees.rs`), so
/// a plain `pull` on a brand-new branch fails with "no tracking
/// information" until someone runs `--set-upstream` by hand. If the
/// remote already has a branch of this name, wire tracking to it; if it
/// doesn't, that's a genuine error rather than a setup step to paper
/// over, and the caller reports it.
async fn ensure_pull_upstream(dir: &Path) -> Result<String, GitRemoteError> {
    if let Some(existing) = upstream_ref(dir).await {
        return Ok(existing);
    }

    let branch = current_branch(dir)
        .await
        .map_err(|e| local_failure(RemoteOp::Pull, e))?;
    let remote = default_remote(dir).await?;

    run_remote_git(dir, &["fetch", &remote])
        .await
        .map_err(|f| classify(RemoteOp::Pull, &f.output, f.timed_out))?;

    let remote_ref = format!("{remote}/{branch}");
    if run_git(dir, &["rev-parse", "--verify", "--quiet", &remote_ref])
        .await
        .is_err()
    {
        return Err(GitRemoteError::simple(
            GitErrorCode::NoRemoteBranch,
            "No matching branch on the remote",
            &format!("`{remote}` has no branch called `{branch}`, so there's nothing to pull. Push this branch first to create it."),
            format!("{remote_ref} does not exist"),
        ));
    }

    run_git(dir, &["branch", "--set-upstream-to", &remote_ref, &branch])
        .await
        .map_err(|e| local_failure(RemoteOp::Pull, e))?;
    Ok(remote_ref)
}

// ---------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------

/// How a pull should reconcile local and remote history. The default is
/// the conservative one; the others are only ever chosen by the user
/// clicking the remedy the error card offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    /// `git pull --ff-only` — never invents a merge commit. A diverged
    /// history surfaces as an error for the user to decide on.
    #[default]
    FastForward,
    /// Stash (including untracked files), fast-forward, restore. Handles
    /// both "local changes would be overwritten" *and* "untracked files
    /// would be overwritten" — unlike git's own `--autostash`, which only
    /// covers tracked files.
    StashFastForward,
    /// `git pull --rebase --autostash` — replay local commits on top.
    Rebase,
    /// `git pull --no-rebase` — an explicit merge commit.
    Merge,
}

/// What actually happened, for the success toast. Pull is the one
/// operation where "nothing to do" and "moved 198 commits" both look like
/// silence otherwise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutcome {
    /// One line, already phrased for display.
    pub summary: String,
}

async fn head_hash(dir: &Path) -> Option<String> {
    run_git(dir, &["rev-parse", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
}

async fn count_between(dir: &Path, from: &str, to: &str) -> u32 {
    run_git(dir, &["rev-list", "--count", &format!("{from}..{to}")])
        .await
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn plural(n: u32, word: &str) -> String {
    if n == 1 {
        format!("{n} {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// The top stash's hash, used to tell "a stash was created" from git's
/// exit-zero "No local changes to save".
async fn stash_head(dir: &Path) -> Option<String> {
    run_git(dir, &["rev-parse", "--verify", "--quiet", "refs/stash"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub async fn pull(dir: &Path, strategy: PullStrategy) -> Result<RemoteOutcome, GitRemoteError> {
    let upstream = ensure_pull_upstream(dir).await?;
    let before = head_hash(dir).await;

    let stashed = if strategy == PullStrategy::StashFastForward {
        let before_stash = stash_head(dir).await;
        run_git(
            dir,
            &[
                "stash",
                "push",
                "--include-untracked",
                "-m",
                AUTO_STASH_MESSAGE,
            ],
        )
        .await
        .map_err(|e| local_failure(RemoteOp::Pull, e))?;
        stash_head(dir).await != before_stash
    } else {
        false
    };

    // `-c pull.rebase=false` is not redundant with `--ff-only`: with
    // `pull.rebase=true` configured (common, and set globally by plenty
    // of people), `git pull --ff-only` still runs git's *rebase*
    // precondition checks first and dies with "cannot pull with rebase:
    // You have unstaged changes" — a different, path-less message for
    // what is really the ordinary blocked-by-local-changes case.
    // Pinning the config makes each strategy mean exactly what it says
    // regardless of the user's own `pull.*` settings.
    let args: &[&str] = match strategy {
        PullStrategy::FastForward | PullStrategy::StashFastForward => {
            &["-c", "pull.rebase=false", "pull", "--ff-only"]
        }
        PullStrategy::Rebase => &[
            "-c",
            "rebase.autoStash=true",
            "pull",
            "--rebase",
            "--autostash",
        ],
        PullStrategy::Merge => &[
            "-c",
            "pull.rebase=false",
            "pull",
            "--no-rebase",
            "--no-edit",
        ],
    };

    let pull_result = run_remote_git(dir, args).await;

    // Whatever happened, the user's work comes back out of the stash
    // before we return — leaving a failed pull with the working tree
    // silently emptied would be far worse than the original error.
    // `git stash pop` keeps the stash when it can't apply cleanly, so a
    // failure here is recoverable in every case; what matters is that the
    // user is told where their work went.
    let pop_failed = stashed && run_git(dir, &["stash", "pop"]).await.is_err();

    if let Err(failure) = pull_result {
        let mut err = classify(RemoteOp::Pull, &failure.output, failure.timed_out);
        if pop_failed {
            err.message.push_str(
                " Your uncommitted work was stashed before this attempt and couldn't be restored automatically — it's safe in the Stashes section.",
            );
        }
        return Err(err);
    }

    if pop_failed {
        return Err(GitRemoteError {
            code: GitErrorCode::MergeConflict,
            title: "Pulled, but your stashed changes conflict".to_string(),
            message: "The pull succeeded. Restoring your stashed changes hit conflicts, so they're still saved in the Stashes section — resolve the conflicts and pop it from there."
                .to_string(),
            detail: format!("`git stash pop` could not apply {AUTO_STASH_MESSAGE} cleanly"),
            paths: Vec::new(),
            actions: Vec::new(),
        });
    }

    let after = head_hash(dir).await;
    let summary = match (before, after) {
        (Some(before), Some(after)) if before == after => {
            format!("Already up to date with {upstream}")
        }
        (Some(before), Some(_)) => {
            let n = count_between(dir, &before, "HEAD").await;
            if n == 0 {
                format!("Updated from {upstream}")
            } else {
                format!("Pulled {} from {upstream}", plural(n, "commit"))
            }
        }
        _ => format!("Pulled from {upstream}"),
    };

    Ok(RemoteOutcome { summary })
}

/// A plain `git push` on a brand-new worktree branch always fails with
/// "no upstream branch", so that exact failure is retried with
/// `--set-upstream <remote> <branch>` — the same thing `git push -u`
/// would do, without changing behavior for branches that already track a
/// remote (the plain push still runs first, and is enough for that case).
pub async fn push(dir: &Path, force_with_lease: bool) -> Result<RemoteOutcome, GitRemoteError> {
    let branch = current_branch(dir)
        .await
        .map_err(|e| local_failure(RemoteOp::Push, e))?;
    if branch == "HEAD" {
        return Err(GitRemoteError::simple(
            GitErrorCode::DetachedHead,
            "HEAD is detached",
            "This worktree isn't on a branch, so there's nothing to push. Check out a branch first.",
            "git rev-parse --abbrev-ref HEAD returned HEAD".to_string(),
        ));
    }

    let mut base: Vec<&str> = vec!["push"];
    if force_with_lease {
        base.push("--force-with-lease");
    }

    let ahead_before = match upstream_ref(dir).await {
        Some(upstream) => count_between(dir, &upstream, "HEAD").await,
        None => 0,
    };

    let result = match run_remote_git(dir, &base).await {
        Ok(out) => Ok(out),
        Err(failure)
            if failure
                .output
                .to_lowercase()
                .contains("has no upstream branch") =>
        {
            let remote = default_remote(dir).await?;
            let mut args = base.clone();
            args.extend(["--set-upstream", &remote, &branch]);
            run_remote_git(dir, &args).await
        }
        Err(failure) => Err(failure),
    };

    let output = result.map_err(|f| classify(RemoteOp::Push, &f.output, f.timed_out))?;

    let upstream = upstream_ref(dir).await.unwrap_or_else(|| branch.clone());
    let summary = if output.to_lowercase().contains("everything up-to-date") || ahead_before == 0 {
        format!("Everything up to date on {upstream}")
    } else {
        format!("Pushed {} to {upstream}", plural(ahead_before, "commit"))
    };

    Ok(RemoteOutcome { summary })
}

pub async fn fetch(dir: &Path) -> Result<RemoteOutcome, GitRemoteError> {
    run_remote_git(dir, &["fetch", "--prune"])
        .await
        .map_err(|f| classify(RemoteOp::Fetch, &f.output, f.timed_out))?;
    Ok(RemoteOutcome {
        summary: "Fetched from remote".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::working_status;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn git(dir: &Path, args: &[&str]) -> String {
        run_git(dir, args)
            .await
            .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
    }

    async fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]).await;
        git(dir, &["config", "user.email", "test@example.com"]).await;
        git(dir, &["config", "user.name", "Test"]).await;
    }

    /// A bare repo, a "seed" clone that stands in for another developer
    /// pushing to it, and the clone under test. Every `TempDir` is held
    /// on the struct: dropping one deletes the directory out from under
    /// the still-running test.
    struct Fixture {
        _remote: TempDir,
        _work: TempDir,
        _seed: TempDir,
        /// Push commits from here to make the clone out of date.
        seed: PathBuf,
        /// The repo under test.
        clone: PathBuf,
    }

    /// A bare repo plus a clone of it — enough to exercise every remote
    /// path (fetch/pull/push, upstream wiring, rejection) for real,
    /// without a network.
    async fn repo_with_remote() -> Fixture {
        let remote = TempDir::new().unwrap();
        git(remote.path(), &["init", "--bare", "-b", "main"]).await;

        let seed = TempDir::new().unwrap();
        init_repo(seed.path()).await;
        std::fs::write(seed.path().join("README.md"), "hello\n").unwrap();
        git(seed.path(), &["add", "."]).await;
        git(seed.path(), &["commit", "-m", "init"]).await;
        let remote_url = remote.path().to_string_lossy().to_string();
        git(seed.path(), &["remote", "add", "origin", &remote_url]).await;
        git(seed.path(), &["push", "-u", "origin", "main"]).await;

        let work = TempDir::new().unwrap();
        let clone_path = work.path().join("clone");
        git(
            work.path(),
            &["clone", &remote_url, clone_path.to_string_lossy().as_ref()],
        )
        .await;
        git(&clone_path, &["config", "user.email", "clone@example.com"]).await;
        git(&clone_path, &["config", "user.name", "Clone"]).await;

        Fixture {
            seed: seed.path().to_path_buf(),
            clone: clone_path,
            _remote: remote,
            _work: work,
            _seed: seed,
        }
    }

    /// Adds a commit upstream (via the seed clone) so the other clone is
    /// one commit behind.
    async fn advance_remote(seed: &Path, file: &str, contents: &str) {
        std::fs::write(seed.join(file), contents).unwrap();
        git(seed, &["add", "."]).await;
        git(seed, &["commit", "-m", &format!("remote edit {file}")]).await;
        git(seed, &["push"]).await;
    }

    #[tokio::test]
    async fn pull_fast_forwards_and_reports_the_commit_count() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "README.md", "hello from remote\n").await;

        let outcome = pull(clone, PullStrategy::FastForward).await.unwrap();
        assert!(
            outcome.summary.contains("Pulled 1 commit"),
            "unexpected summary: {}",
            outcome.summary
        );
        assert_eq!(
            std::fs::read_to_string(clone.join("README.md")).unwrap(),
            "hello from remote\n"
        );

        let outcome = pull(clone, PullStrategy::FastForward).await.unwrap();
        assert!(
            outcome.summary.starts_with("Already up to date"),
            "unexpected summary: {}",
            outcome.summary
        );
    }

    /// The exact failure from the bug report: a dirty working tree makes
    /// `pull --ff-only` abort, and the raw stderr is useless on its own.
    #[tokio::test]
    async fn pull_blocked_by_local_changes_is_classified_with_paths_and_a_remedy() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "README.md", "hello from remote\n").await;
        std::fs::write(clone.join("README.md"), "my local edit\n").unwrap();

        let err = pull(clone, PullStrategy::FastForward).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::DirtyWorkingTree);
        assert_eq!(err.paths, vec!["README.md".to_string()]);
        assert!(err.actions.contains(&GitErrorAction::StashAndPull));
        assert!(!err.detail.is_empty());
    }

    #[tokio::test]
    async fn pull_blocked_by_untracked_files_is_classified_with_paths() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "NOTES.md", "from remote\n").await;
        std::fs::write(clone.join("NOTES.md"), "mine, uncommitted\n").unwrap();

        let err = pull(clone, PullStrategy::FastForward).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::UntrackedOverwrite);
        assert_eq!(err.paths, vec!["NOTES.md".to_string()]);
        assert!(err.actions.contains(&GitErrorAction::StashAndPull));
    }

    /// The remedy the error card offers has to actually work — including
    /// for untracked files, which git's own `--autostash` does not cover.
    #[tokio::test]
    async fn stash_and_pull_restores_tracked_and_untracked_work() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "SERVER.md", "server side\n").await;
        std::fs::write(clone.join("README.md"), "my local edit\n").unwrap();
        std::fs::write(clone.join("scratch.txt"), "untracked work\n").unwrap();

        pull(clone, PullStrategy::StashFastForward).await.unwrap();
        assert!(clone.join("SERVER.md").exists(), "pull did not land");
        assert_eq!(
            std::fs::read_to_string(clone.join("README.md")).unwrap(),
            "my local edit\n",
            "tracked edit was not restored"
        );
        assert_eq!(
            std::fs::read_to_string(clone.join("scratch.txt")).unwrap(),
            "untracked work\n",
            "untracked file was not restored"
        );

        let stashes = crate::git::list_stashes(clone).await.unwrap();
        assert!(
            stashes.is_empty(),
            "auto-stash was left behind: {stashes:?}"
        );
    }

    /// Stash-and-pull can still land in a conflict — when the incoming
    /// commit and the stashed edit touch the same lines. The pull is kept
    /// (it succeeded), the stash is kept too, and the user is told where
    /// their work is rather than being left to wonder.
    #[tokio::test]
    async fn stash_and_pull_keeps_the_stash_when_restoring_conflicts() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "README.md", "remote rewrite\n").await;
        std::fs::write(clone.join("README.md"), "my local edit\n").unwrap();

        let err = pull(clone, PullStrategy::StashFastForward)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::MergeConflict);
        assert!(err.title.contains("stashed changes conflict"));

        // The pull landed and the work is still recoverable.
        let stashes = crate::git::list_stashes(clone).await.unwrap();
        assert_eq!(stashes.len(), 1, "the stash must survive a failed pop");
        assert!(stashes[0].message.contains(AUTO_STASH_MESSAGE));
    }

    /// A stash taken for a pull that then fails must still come back —
    /// the user's tree cannot be left emptied by a failed operation.
    #[tokio::test]
    async fn stash_and_pull_restores_work_even_when_the_pull_fails() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        // Diverge: a local commit plus a different remote commit means
        // --ff-only cannot succeed.
        advance_remote(seed, "README.md", "remote version\n").await;
        std::fs::write(clone.join("local.md"), "local commit\n").unwrap();
        git(clone, &["add", "."]).await;
        git(clone, &["commit", "-m", "local"]).await;
        std::fs::write(clone.join("dirty.txt"), "uncommitted\n").unwrap();

        let err = pull(clone, PullStrategy::StashFastForward)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::Diverged);
        assert!(err.actions.contains(&GitErrorAction::RebasePull));
        assert_eq!(
            std::fs::read_to_string(clone.join("dirty.txt")).unwrap(),
            "uncommitted\n",
            "working tree was left stashed after a failed pull"
        );
    }

    #[tokio::test]
    async fn rebase_pull_resolves_a_diverged_branch() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "SERVER.md", "server side\n").await;
        std::fs::write(clone.join("local.md"), "local commit\n").unwrap();
        git(clone, &["add", "."]).await;
        git(clone, &["commit", "-m", "local"]).await;

        pull(clone, PullStrategy::Rebase).await.unwrap();
        assert!(clone.join("SERVER.md").exists());
        assert!(clone.join("local.md").exists());
        let status = working_status(clone).await.unwrap();
        assert_eq!(status.behind, 0);
        assert_eq!(status.ahead, 1);
    }

    #[tokio::test]
    async fn push_reports_what_it_pushed_and_wires_up_a_new_branch() {
        let fx = repo_with_remote().await;
        let clone = fx.clone.as_path();
        git(clone, &["checkout", "-b", "feature"]).await;
        std::fs::write(clone.join("feature.md"), "new\n").unwrap();
        git(clone, &["add", "."]).await;
        git(clone, &["commit", "-m", "feature"]).await;

        // No upstream at all: push must set one rather than failing.
        let outcome = push(clone, false).await.unwrap();
        assert!(
            outcome.summary.contains("origin/feature"),
            "unexpected summary: {}",
            outcome.summary
        );
        assert_eq!(upstream_ref(clone).await.as_deref(), Some("origin/feature"));

        let outcome = push(clone, false).await.unwrap();
        assert!(
            outcome.summary.starts_with("Everything up to date"),
            "unexpected summary: {}",
            outcome.summary
        );
    }

    #[tokio::test]
    async fn rejected_push_offers_pull_or_force() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        advance_remote(seed, "README.md", "remote version\n").await;
        std::fs::write(clone.join("local.md"), "local commit\n").unwrap();
        git(clone, &["add", "."]).await;
        git(clone, &["commit", "-m", "local"]).await;

        let err = push(clone, false).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::Rejected);
        assert_eq!(
            err.actions,
            vec![GitErrorAction::PullThenPush, GitErrorAction::ForcePush]
        );

        // Force-with-lease refuses while the remote holds commits this
        // clone has never fetched — that is the lease working, and it has
        // to read as its own explained error rather than git's "stale
        // info".
        let err = push(clone, true).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::ForcePushStale);
        assert_eq!(err.actions, vec![GitErrorAction::PullThenPush]);

        // Once those commits have been seen, the lease is satisfied and
        // the force push goes through.
        fetch(clone).await.unwrap();
        let outcome = push(clone, true).await.unwrap();
        assert!(outcome.summary.contains("origin/main"));
    }

    /// `pull.rebase = true` in the user's own config used to turn the
    /// ordinary "you have local changes" pull failure into git's
    /// path-less rebase precondition error, which classified as
    /// `Unknown` and offered no remedy.
    #[tokio::test]
    async fn pull_is_unaffected_by_a_user_configured_pull_rebase() {
        let fx = repo_with_remote().await;
        let (seed, clone) = (fx.seed.as_path(), fx.clone.as_path());
        git(clone, &["config", "pull.rebase", "true"]).await;
        advance_remote(seed, "README.md", "hello from remote\n").await;

        // Clean tree: still a plain fast-forward, not a rebase.
        pull(clone, PullStrategy::FastForward).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(clone.join("README.md")).unwrap(),
            "hello from remote\n"
        );

        // Dirty tree, in a file the incoming commit also touches.
        advance_remote(seed, "README.md", "second remote edit\n").await;
        std::fs::write(clone.join("README.md"), "my local edit\n").unwrap();
        let err = pull(clone, PullStrategy::FastForward).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::DirtyWorkingTree);
        assert_eq!(err.paths, vec!["README.md".to_string()]);
        assert!(err.actions.contains(&GitErrorAction::StashAndPull));
    }

    #[tokio::test]
    async fn pull_on_a_branch_the_remote_does_not_have_explains_itself() {
        let fx = repo_with_remote().await;
        let clone = fx.clone.as_path();
        git(clone, &["checkout", "-b", "solo"]).await;

        let err = pull(clone, PullStrategy::FastForward).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::NoRemoteBranch);
        assert!(err.message.contains("Push this branch first"));
    }

    #[tokio::test]
    async fn remote_operations_on_a_repo_without_a_remote_say_so() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path()).await;
        std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        git(dir.path(), &["add", "."]).await;
        git(dir.path(), &["commit", "-m", "init"]).await;

        let err = pull(dir.path(), PullStrategy::FastForward)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::NoRemote);

        let err = push(dir.path(), false).await.unwrap_err();
        assert_eq!(err.code, GitErrorCode::NoRemote);
    }

    /// Git never gets a chance to prompt: with stdin closed and
    /// `GIT_TERMINAL_PROMPT=0`, an unreachable HTTPS remote fails instead
    /// of hanging until the timeout.
    #[tokio::test]
    async fn unreachable_remote_fails_instead_of_prompting() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path()).await;
        std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        git(dir.path(), &["add", "."]).await;
        git(dir.path(), &["commit", "-m", "init"]).await;
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://maestro.invalid/does/not/exist.git",
            ],
        )
        .await;

        let err = push(dir.path(), false).await.unwrap_err();
        assert!(
            matches!(
                err.code,
                GitErrorCode::Network | GitErrorCode::AuthFailed | GitErrorCode::RepositoryNotFound
            ),
            "unexpected classification {:?}: {}",
            err.code,
            err.detail
        );
        assert!(!err.title.is_empty() && !err.message.is_empty());
    }

    #[test]
    fn classifies_the_reported_dirty_tree_stderr_verbatim() {
        // Copied from the bug report, tabs and all.
        let output =
            "From https://github.com/example/repo 4a53264a..251fe8d7  sayar -> origin/sayar\n\
            error: Your local changes to the following files would be overwritten by merge:\n\
            \tapps/web/src/pages/api/cron/pre-renewal-invoice-reminders.ts\n\
            \tapps/web/src/server/payment/mobile/subscriptionSync.ts\n\
            Please commit your changes or stash them before you merge.\n\
            error: The following untracked working tree files would be overwritten by merge:\n\
            \tapps/web/src/utils/renewal/renewalReminderOnce.ts\n\
            Please move or remove them before you merge.\n\
            Aborting";

        let err = classify(RemoteOp::Pull, output, false);
        assert_eq!(err.code, GitErrorCode::DirtyWorkingTree);
        assert_eq!(
            err.paths.len(),
            3,
            "every blocking path is listed: {:?}",
            err.paths
        );
        assert_eq!(err.actions.first(), Some(&GitErrorAction::StashAndPull));
        assert_eq!(err.detail, output);
    }

    #[test]
    fn classifies_credential_and_protection_failures() {
        let auth = classify(
            RemoteOp::Push,
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            false,
        );
        assert_eq!(auth.code, GitErrorCode::AuthFailed);

        let protected = classify(
            RemoteOp::Push,
            "remote: error: GH006: Protected branch update failed for refs/heads/main.\n\
             To github.com:example/repo.git\n\
             ! [remote rejected] main -> main (protected branch hook declined)\n\
             error: failed to push some refs",
            false,
        );
        assert_eq!(protected.code, GitErrorCode::HookRejected);
        assert!(protected.message.contains("GH006"));

        let timed_out = classify(RemoteOp::Fetch, "whatever", true);
        assert_eq!(timed_out.code, GitErrorCode::TimedOut);
        assert_eq!(timed_out.actions, vec![GitErrorAction::Retry]);
    }
}
