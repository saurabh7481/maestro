//! Process Manager (docs/V2_ROADMAP.md Phase 15) — one view of every OS
//! process Maestro itself spawned, across every worktree and project.
//!
//! Deliberately a *reporting* layer, not a second lifecycle owner: agent
//! turns, PTY terminals, language servers and worktree hooks each keep the
//! exact ownership they already had (`agents/manager.rs`,
//! `terminal.rs`, `lsp.rs`, `commands/hooks.rs`), and this module only
//! reads their `AppState` bookkeeping and routes a kill request back to
//! whichever of them owns the child. The alternative — a central process
//! table that owns every `Child` — would mean rewriting four working
//! lifecycles to surface information they already track internally, which
//! is precisely the "surface the bookkeeping, don't rebuild it" framing
//! the roadmap phase asks for.
//!
//! Resource metrics come from `sysinfo` rather than hand-rolled `/proc`
//! parsing, since Maestro ships on Linux, macOS and Windows and this is
//! the one part of the feature that is genuinely platform-specific.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

use crate::state::{AgentCancelKind, AppState};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedProcessKind {
    Agent,
    Terminal,
    LanguageServer,
    Hook,
}

/// What the process is doing right now, from Maestro's point of view —
/// not the OS's. An agent tab with no turn in flight is `Idle`: its run
/// entry (and its tab) exist, but there is no child process to kill,
/// which is why `killable` is false for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedProcessStatus {
    Running,
    Idle,
    Exited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProcess {
    /// Subsystem-scoped id — the agent run id (== its tab id), the
    /// terminal id (== its tab id), `worktreeId:serverKind` for a language
    /// server, or the worktree id for a hook run. Paired with `kind` it is
    /// unique, and it is exactly what `kill_managed_process` needs to route
    /// the kill back to the owning subsystem.
    pub id: String,
    pub kind: ManagedProcessKind,
    pub label: String,
    /// Secondary line in the UI — the command being run, the session id,
    /// the server binary. Never a fabricated value: `None` when the owning
    /// subsystem genuinely doesn't track one.
    pub detail: Option<String>,
    pub worktree_id: Option<String>,
    pub worktree_root: Option<String>,
    /// The tab this process belongs to, when it has one, so the frontend
    /// can offer "reveal in tab". Agent and terminal ids *are* tab ids;
    /// language servers and hooks have no tab.
    pub tab_id: Option<String>,
    pub pid: Option<u32>,
    pub started_at_ms: u64,
    pub status: ManagedProcessStatus,
    /// Percent of a single core, summed over the process and its
    /// descendants — an agent CLI that forks workers, or a shell running a
    /// build, is reported as the whole tree it actually costs, not just
    /// the pid Maestro happens to hold.
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    /// Descendants of `pid`, excluding `pid` itself.
    pub child_process_count: u32,
    pub killable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub processes: Vec<ManagedProcess>,
    pub sampled_at_ms: u64,
    pub cpu_core_count: usize,
    pub total_memory_bytes: u64,
    /// False on the very first sample of a session. CPU usage is a delta
    /// between two refreshes, so the first one has nothing to compare
    /// against and every process reads 0% — the UI says "measuring…"
    /// rather than claiming a real zero.
    pub cpu_ready: bool,
}

#[derive(Debug, Default, Clone, Copy)]
struct Metrics {
    cpu_percent: f32,
    memory_bytes: u64,
    child_process_count: u32,
    alive: bool,
}

/// One long-lived `System` for the whole app rather than a fresh one per
/// poll: `sysinfo` computes CPU usage as the delta between consecutive
/// refreshes of the *same* instance, so a per-call instance would report
/// 0% forever. Kept here instead of in `AppState` because nothing outside
/// this module has any business touching it.
fn sampler() -> &'static Mutex<(System, bool)> {
    static SAMPLER: OnceLock<Mutex<(System, bool)>> = OnceLock::new();
    SAMPLER.get_or_init(|| Mutex::new((System::new(), false)))
}

/// Refreshes the process table once and rolls up each requested pid's
/// whole subtree. Returns `(metrics_by_pid, cpu_ready, core_count,
/// total_memory)`.
fn sample_metrics(pids: &[u32]) -> (HashMap<u32, Metrics>, bool, usize, u64) {
    let mut guard = match sampler().lock() {
        Ok(guard) => guard,
        // A poisoned sampler means a previous poll panicked mid-refresh.
        // Metrics are decoration; the process list itself is the point, so
        // degrade to "no metrics" rather than failing the whole command.
        Err(_) => return (HashMap::new(), false, 0, 0),
    };
    let (system, sampled_once) = &mut *guard;
    // Total RAM is what turns a per-process byte count into "3% of this
    // machine" in the UI, and the core count is what makes a 180% CPU
    // reading legible on an 8-core box. Both come from `System`'s
    // non-process collectors, which `refresh_processes_specifics` alone
    // never populates.
    if !*sampled_once {
        system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    }
    system.refresh_memory_specifics(sysinfo::MemoryRefreshKind::nothing().with_ram());
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        // Tasks (Linux threads) are excluded: they would otherwise show up
        // as children of the process they belong to and double-count its
        // memory in the subtree roll-up below.
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .without_tasks(),
    );
    let cpu_ready = *sampled_once;
    *sampled_once = true;

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }

    let mut out = HashMap::new();
    for &pid in pids {
        let Some(root) = system.process(Pid::from_u32(pid)) else {
            out.insert(pid, Metrics::default());
            continue;
        };
        let mut metrics = Metrics {
            cpu_percent: root.cpu_usage(),
            memory_bytes: root.memory(),
            child_process_count: 0,
            alive: true,
        };
        // Breadth-first over descendants, with a visited set — a pid table
        // read live can briefly contain a cycle after pid reuse, and an
        // unbounded walk here would hang the whole poll.
        let mut seen: HashSet<u32> = HashSet::from([pid]);
        let mut queue: VecDeque<u32> = VecDeque::from([pid]);
        while let Some(current) = queue.pop_front() {
            for &child in children.get(&current).map(Vec::as_slice).unwrap_or(&[]) {
                if !seen.insert(child) {
                    continue;
                }
                if let Some(process) = system.process(Pid::from_u32(child)) {
                    metrics.cpu_percent += process.cpu_usage();
                    metrics.memory_bytes += process.memory();
                    metrics.child_process_count += 1;
                }
                queue.push_back(child);
            }
        }
        out.insert(pid, metrics);
    }

    let cores = system.cpus().len();
    let total_memory = system.total_memory();
    (out, cpu_ready, cores, total_memory)
}

/// Everything Maestro spawned, newest first. Cheap enough to poll on a
/// timer (one `/proc` sweep plus four `AppState` map reads); the frontend
/// only polls while the Process Manager tab or its status-bar popover is
/// actually open (`state/processStore.ts`).
#[tauri::command]
pub async fn list_managed_processes(state: State<'_, AppState>) -> Result<ProcessSnapshot, String> {
    struct Row {
        id: String,
        kind: ManagedProcessKind,
        label: String,
        detail: Option<String>,
        worktree_id: Option<String>,
        worktree_root: Option<String>,
        tab_id: Option<String>,
        pid: Option<u32>,
        started_at_ms: u64,
        status: ManagedProcessStatus,
    }

    let mut rows: Vec<Row> = Vec::new();

    {
        let runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
        for (run_id, entry) in runs.iter() {
            // A run entry outlives any single turn's child process (see
            // `AgentRunEntry`'s doc comment) — `cancel_tx`/`pid` are only
            // `Some` while a turn is actually in flight.
            let running = entry.cancel_tx.is_some();
            rows.push(Row {
                id: run_id.clone(),
                kind: ManagedProcessKind::Agent,
                label: entry.kind.display_name().to_string(),
                detail: entry
                    .session_id
                    .as_ref()
                    .map(|id| format!("session {id}"))
                    .or_else(|| Some("no session yet".to_string())),
                worktree_id: Some(entry.worktree_id.clone()),
                worktree_root: Some(entry.worktree_root.clone()),
                tab_id: Some(run_id.clone()),
                pid: entry.pid,
                started_at_ms: entry.started_at_ms,
                status: if running {
                    ManagedProcessStatus::Running
                } else {
                    ManagedProcessStatus::Idle
                },
            });
        }
    }

    {
        let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        for (terminal_id, handle) in terminals.iter() {
            rows.push(Row {
                id: terminal_id.clone(),
                kind: ManagedProcessKind::Terminal,
                label: handle.shell_name().to_string(),
                detail: Some(handle.shell.clone()),
                worktree_id: None,
                worktree_root: Some(handle.worktree_path.clone()),
                tab_id: Some(terminal_id.clone()),
                pid: handle.pid,
                started_at_ms: handle.started_at_ms,
                status: ManagedProcessStatus::Running,
            });
        }
    }

    {
        let servers = state.lsp_servers.lock().map_err(|e| e.to_string())?;
        for (key, entry) in servers.iter() {
            rows.push(Row {
                id: format!("{}:{}", key.worktree_id, key.kind.slug()),
                kind: ManagedProcessKind::LanguageServer,
                label: key.kind.display_name().to_string(),
                detail: Some(entry.binary_path.clone()),
                worktree_id: Some(key.worktree_id.clone()),
                worktree_root: Some(entry.worktree_root.clone()),
                tab_id: None,
                pid: entry.pid,
                started_at_ms: entry.started_at_ms,
                status: ManagedProcessStatus::Running,
            });
        }
    }

    {
        let hooks = state.hook_runs.lock().map_err(|e| e.to_string())?;
        for (worktree_id, entry) in hooks.iter() {
            rows.push(Row {
                id: worktree_id.clone(),
                kind: ManagedProcessKind::Hook,
                label: "Worktree setup hook".to_string(),
                detail: Some(entry.branch.clone()),
                worktree_id: Some(worktree_id.clone()),
                worktree_root: Some(entry.worktree_path.clone()),
                tab_id: None,
                pid: entry.pid,
                started_at_ms: entry.started_at_ms,
                status: ManagedProcessStatus::Running,
            });
        }
    }

    let pids: Vec<u32> = rows.iter().filter_map(|row| row.pid).collect();
    let (metrics, cpu_ready, cpu_core_count, total_memory_bytes) = sample_metrics(&pids);

    let mut processes: Vec<ManagedProcess> = rows
        .into_iter()
        .map(|row| {
            let measured = row.pid.and_then(|pid| metrics.get(&pid)).copied();
            let alive = measured.map(|m| m.alive).unwrap_or(false);
            let status = match row.status {
                // The pid is gone but our bookkeeping hasn't caught up yet
                // (the reaping task runs a moment behind the child). Say so
                // rather than reporting a dead process as running.
                ManagedProcessStatus::Running if row.pid.is_some() && !alive => {
                    ManagedProcessStatus::Exited
                }
                other => other,
            };
            let measured = measured.unwrap_or_default();
            ManagedProcess {
                killable: matches!(status, ManagedProcessStatus::Running),
                id: row.id,
                kind: row.kind,
                label: row.label,
                detail: row.detail,
                worktree_id: row.worktree_id,
                worktree_root: row.worktree_root,
                tab_id: row.tab_id,
                pid: row.pid,
                started_at_ms: row.started_at_ms,
                status,
                cpu_percent: measured.cpu_percent,
                memory_bytes: measured.memory_bytes,
                child_process_count: measured.child_process_count,
            }
        })
        .collect();

    processes.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then(a.id.cmp(&b.id)));

    Ok(ProcessSnapshot {
        processes,
        sampled_at_ms: now_ms(),
        cpu_core_count,
        total_memory_bytes,
        cpu_ready,
    })
}

/// Routes a kill back to whichever subsystem owns the child, using the
/// same code path that subsystem's own UI already uses — this command
/// adds a caller, not a second way to kill things.
///
/// Agent runs are the one deliberate asymmetry: this cancels the *turn*
/// (like the tab's own stop button) and leaves the run entry alive, so
/// the tab it belongs to stays usable. Closing the tab is still what
/// disposes the run.
#[tauri::command]
pub async fn kill_managed_process(
    state: State<'_, AppState>,
    kind: ManagedProcessKind,
    id: String,
) -> Result<(), String> {
    match kind {
        ManagedProcessKind::Agent => {
            let sender = {
                let mut runs = state.agent_runs.lock().map_err(|e| e.to_string())?;
                runs.get_mut(&id).and_then(|entry| entry.cancel_tx.take())
            };
            if let Some(tx) = sender {
                let _ = tx.send(AgentCancelKind::Hard);
            }
            Ok(())
        }
        ManagedProcessKind::Terminal => {
            let handle = {
                let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
                terminals.remove(&id)
            };
            if let Some(mut handle) = handle {
                let _ = handle.child.kill();
            }
            Ok(())
        }
        ManagedProcessKind::LanguageServer => {
            let (worktree_id, server_id) = id
                .rsplit_once(':')
                .ok_or_else(|| "malformed language server id".to_string())?;
            let server_kind = crate::lsp::LspServerKind::from_slug(server_id)
                .ok_or_else(|| format!("unknown language server '{server_id}'"))?;
            let key = crate::lsp::LspProcessKey {
                worktree_id: worktree_id.to_string(),
                kind: server_kind,
            };
            let entry = {
                let mut servers = state.lsp_servers.lock().map_err(|e| e.to_string())?;
                servers.remove(&key)
            };
            match entry {
                Some(entry) => entry
                    .control_tx
                    .send(crate::lsp::LspControlMessage::Stop)
                    .await
                    .map_err(|_| "Language server already stopped.".to_string()),
                None => Ok(()),
            }
        }
        ManagedProcessKind::Hook => {
            let entry = {
                let mut hooks = state.hook_runs.lock().map_err(|e| e.to_string())?;
                hooks.remove(&id)
            };
            if let Some(entry) = entry {
                let _ = entry.cancel_tx.send(());
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sampler must report *this* process (which certainly exists) as
    /// alive with non-zero memory — enough to catch a `sysinfo` upgrade
    /// silently changing units or the refresh kind dropping memory.
    #[test]
    fn samples_the_current_process() {
        let pid = std::process::id();
        let (metrics, _, cores, total_memory) = sample_metrics(&[pid]);
        let measured = metrics.get(&pid).copied().unwrap_or_default();
        assert!(measured.alive, "current process should be visible");
        assert!(
            measured.memory_bytes > 0,
            "current process should use memory"
        );
        assert!(cores > 0);
        assert!(total_memory > 0);
    }

    /// A pid that cannot exist must come back as a dead row rather than
    /// panicking or being dropped from the map — `list_managed_processes`
    /// relies on that to flip a stale entry to `Exited`.
    #[test]
    fn reports_unknown_pids_as_dead() {
        let (metrics, _, _, _) = sample_metrics(&[u32::MAX]);
        let measured = metrics.get(&u32::MAX).copied().unwrap_or_default();
        assert!(!measured.alive);
        assert_eq!(measured.memory_bytes, 0);
    }

    /// First sample of a process has no previous refresh to diff against;
    /// the second does. The UI reads this to avoid showing a fake 0%.
    #[test]
    fn cpu_readiness_flips_after_the_first_sample() {
        let pid = std::process::id();
        let (_, _, _, _) = sample_metrics(&[pid]);
        let (_, cpu_ready, _, _) = sample_metrics(&[pid]);
        assert!(cpu_ready);
    }
}
