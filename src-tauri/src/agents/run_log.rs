//! A sequenced, replayable event log per agent run — the thing that makes
//! a second client (the mobile relay, another paired device) able to show
//! the *same* conversation as the desktop rather than an approximation of
//! it.
//!
//! Before this, `agent://{run_id}/event` was a fire-and-forget fan-out
//! with no history: a client learned only what happened while it happened
//! to be attached. Everything else was inferred badly —
//!
//! * a phone opening a session mid-turn had no idea a turn was running,
//!   because "working" was only ever set by the client that sent the
//!   prompt itself;
//! * its transcript came from the desktop's *debounced* SQLite copy,
//!   which during a continuously streaming turn never gets written at all;
//! * and every WebSocket drop — routine on a phone handing off between
//!   WiFi and cellular — silently lost whatever arrived while it was
//!   reconnecting, with nothing to detect the hole afterwards.
//!
//! So: every event is appended here under a monotonic `seq` *and then*
//! emitted, by one function, so the log and the fan-out can never
//! disagree. Clients track the last `seq` they saw and reconnect with
//! `?since=`, which replays the gap exactly. Run status is folded from the
//! same events as they land, so it is a fact about the run rather than a
//! guess by whoever is watching.
//!
//! The log is capped. When it drops events it records how far it has been
//! compacted, and a client asking for something older is told
//! `truncated` and reloads from scratch — a client that knows it is
//! behind is recoverable, a silent gap is not.

use std::collections::VecDeque;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::events::AgentEvent;
use crate::state::AppState;

/// Roughly an hour of a busy run: text deltas are already coalesced at
/// ~60ms (`manager.rs::DELTA_FLUSH_INTERVAL`), so this is thousands of
/// tool calls and messages, not thousands of tokens. Bounded because a
/// long-lived tab must not grow the process without limit.
const MAX_EVENTS: usize = 4096;

/// Where a run is right now, folded from its own events rather than
/// inferred by a client. `cancel_tx.is_some()` (what `processes.rs` used)
/// only distinguishes "a child process is alive" and cannot see that a
/// turn is parked waiting for the user to approve a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    #[default]
    Idle,
    Working,
    AwaitingPermission,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedEvent {
    pub seq: u64,
    pub event: AgentEvent,
}

#[derive(Debug, Default)]
pub struct RunLog {
    events: VecDeque<SequencedEvent>,
    /// The seq the *next* event will get. Starts at 1, so `since=0` means
    /// "I have nothing, send me everything".
    next_seq: u64,
    /// Highest seq that has been dropped by compaction. A client asking
    /// for `since < this` cannot be served a gap-free stream and is told
    /// to reload instead.
    dropped_through_seq: u64,
    status: RunStatus,
}

impl RunLog {
    fn push(&mut self, event: AgentEvent) -> SequencedEvent {
        if self.next_seq == 0 {
            self.next_seq = 1;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.status = fold_status(self.status, &event);
        let sequenced = SequencedEvent { seq, event };
        self.events.push_back(sequenced.clone());
        while self.events.len() > MAX_EVENTS {
            if let Some(dropped) = self.events.pop_front() {
                self.dropped_through_seq = dropped.seq;
            }
        }
        sequenced
    }

    /// Events after `since`, and whether the caller asked for a point this
    /// log can no longer reach.
    fn since(&self, since: u64) -> (Vec<SequencedEvent>, bool) {
        let truncated = since < self.dropped_through_seq;
        let events = self
            .events
            .iter()
            .filter(|e| e.seq > since)
            .cloned()
            .collect();
        (events, truncated)
    }
}

/// How one event moves a run's status.
///
/// A user message is what *starts* a turn, which is why it — not the
/// spawn — is the transition into `Working`: it is the first thing every
/// client sees, whichever device sent it.
fn fold_status(current: RunStatus, event: &AgentEvent) -> RunStatus {
    match event {
        AgentEvent::Message { role, .. } if role == "user" => RunStatus::Working,
        AgentEvent::AwaitingPermission { .. } => RunStatus::AwaitingPermission,
        AgentEvent::Error { .. } => RunStatus::Error,
        // A turn ending clears an error from a *previous* turn, but an
        // error raised during this one has already been reported and
        // should survive until the next turn starts.
        AgentEvent::Exit { .. } | AgentEvent::TurnResult { .. } => {
            if current == RunStatus::Error {
                RunStatus::Error
            } else {
                RunStatus::Idle
            }
        }
        // Content arriving means the model is producing: this recovers
        // `Working` after an approval resumes a parked turn.
        AgentEvent::Message { .. }
        | AgentEvent::MessageDelta { .. }
        | AgentEvent::Thinking { .. }
        | AgentEvent::ToolCall { .. }
        | AgentEvent::ToolResult { .. } => RunStatus::Working,
        AgentEvent::Status { .. }
        | AgentEvent::PermissionDenied { .. }
        | AgentEvent::Raw { .. } => current,
    }
}

/// Appends to the run's log and emits the sequenced payload — the single
/// path every agent event takes.
///
/// Ordering matters and is the whole point: the append happens under the
/// lock *before* the emit, so a client that receives seq N and then asks
/// for "everything after N" can never be told N doesn't exist yet.
pub fn publish(app: &AppHandle, run_id: &str, event: AgentEvent) {
    let status_changed;
    let sequenced = {
        let state = app.state::<AppState>();
        let Ok(mut logs) = state.agent_run_logs.lock() else {
            // A poisoned lock must not silently swallow the event — emit
            // it unsequenced so live clients still see it.
            let _ = app.emit(
                &super::manager::agent_event_channel(run_id),
                &SequencedEvent { seq: 0, event },
            );
            return;
        };
        let log = logs.entry(run_id.to_string()).or_default();
        let before = log.status;
        let sequenced = log.push(event);
        status_changed = log.status != before;
        sequenced
    };
    let _ = app.emit(&super::manager::agent_event_channel(run_id), &sequenced);
    // A run going Working -> Idle (or parking on a permission prompt) is a
    // change to the *session list*, not just to this run's transcript, and
    // anything watching the list has to hear about it without waiting for
    // its next poll.
    if status_changed {
        crate::relay::notify_sessions_changed(app);
    }
}

/// Everything a client needs to start showing a run correctly: where the
/// log is now, what the run is doing, and the events it hasn't seen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub status: RunStatus,
    /// Seq of the newest event in this snapshot; pass back as `since` to
    /// resume from exactly here.
    pub seq: u64,
    pub events: Vec<SequencedEvent>,
    /// The requested `since` is older than the log can serve. The client's
    /// transcript is not recoverable from `events` alone and it should
    /// reload from the persisted transcript instead of rendering a hole.
    pub truncated: bool,
    /// No in-memory log for this run at all — it predates this process
    /// (an app restart), so the persisted transcript is the only history.
    pub cold: bool,
}

pub fn snapshot(app: &AppHandle, run_id: &str, since: u64) -> RunSnapshot {
    let state = app.state::<AppState>();
    let Ok(logs) = state.agent_run_logs.lock() else {
        return RunSnapshot {
            status: RunStatus::Idle,
            seq: 0,
            events: Vec::new(),
            truncated: false,
            cold: true,
        };
    };
    let Some(log) = logs.get(run_id) else {
        return RunSnapshot {
            status: RunStatus::Idle,
            seq: 0,
            events: Vec::new(),
            truncated: false,
            cold: true,
        };
    };
    let (events, truncated) = log.since(since);
    RunSnapshot {
        status: log.status,
        seq: log.next_seq.saturating_sub(1),
        events,
        truncated,
        cold: false,
    }
}

pub fn status_of(state: &AppState, run_id: &str) -> Option<RunStatus> {
    state
        .agent_run_logs
        .lock()
        .ok()
        .and_then(|logs| logs.get(run_id).map(|log| log.status))
}

/// Drops a closed run's log so a long session doesn't retain every tab the
/// user ever opened. Called from the same place the persisted transcript is
/// deleted — closing a tab is what disposes both.
pub fn forget(state: &AppState, run_id: &str) {
    if let Ok(mut logs) = state.agent_run_logs.lock() {
        logs.remove(run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> AgentEvent {
        AgentEvent::Message {
            role: "user".to_string(),
            text: text.to_string(),
        }
    }

    fn delta(text: &str) -> AgentEvent {
        AgentEvent::MessageDelta {
            text: text.to_string(),
        }
    }

    #[test]
    fn sequences_from_one_so_since_zero_means_everything() {
        let mut log = RunLog::default();
        assert_eq!(log.push(user("hi")).seq, 1);
        assert_eq!(log.push(delta("he")).seq, 2);

        let (events, truncated) = log.since(0);
        assert!(!truncated);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
    }

    /// The reconnect case: a phone that saw through seq 2 must get 3
    /// onwards and nothing it already has.
    #[test]
    fn resumes_from_a_sequence_without_gap_or_repeat() {
        let mut log = RunLog::default();
        for i in 0..5 {
            log.push(delta(&format!("chunk{i}")));
        }
        let (events, truncated) = log.since(2);
        assert!(!truncated);
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
    }

    #[test]
    fn a_client_too_far_behind_is_told_rather_than_given_a_hole() {
        let mut log = RunLog::default();
        for i in 0..(MAX_EVENTS + 10) {
            log.push(delta(&format!("chunk{i}")));
        }
        assert_eq!(log.events.len(), MAX_EVENTS);

        let (_, truncated) = log.since(1);
        assert!(truncated, "a compacted-away point must report truncation");

        let (events, truncated) = log.since(log.next_seq - 2);
        assert!(!truncated, "a recent point is still serveable");
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn a_turn_is_working_from_the_user_message_whoever_sent_it() {
        let mut log = RunLog::default();
        assert_eq!(log.status, RunStatus::Idle);
        log.push(user("do the thing"));
        assert_eq!(log.status, RunStatus::Working);
        log.push(delta("working on it"));
        assert_eq!(log.status, RunStatus::Working);
        log.push(AgentEvent::Exit { code: Some(0) });
        assert_eq!(log.status, RunStatus::Idle);
    }

    #[test]
    fn parking_for_permission_is_its_own_status_and_resumes_to_working() {
        let mut log = RunLog::default();
        log.push(user("edit the file"));
        log.push(AgentEvent::AwaitingPermission {
            tool_use_id: "t1".to_string(),
        });
        assert_eq!(log.status, RunStatus::AwaitingPermission);

        log.push(AgentEvent::ToolResult {
            tool_use_id: "t1".to_string(),
            content: "done".to_string(),
            is_error: false,
            diff_added: None,
            diff_removed: None,
        });
        assert_eq!(log.status, RunStatus::Working);
    }

    /// An error has to survive the exit that follows it, or every failed
    /// turn would report itself as a clean idle.
    #[test]
    fn an_error_outlives_the_exit_that_follows_it() {
        let mut log = RunLog::default();
        log.push(user("go"));
        log.push(AgentEvent::Error {
            message: "boom".to_string(),
        });
        log.push(AgentEvent::Exit { code: Some(1) });
        assert_eq!(log.status, RunStatus::Error);

        // ...but the next turn clears it.
        log.push(user("try again"));
        assert_eq!(log.status, RunStatus::Working);
    }

    /// Transient notes must not move the run out of whatever it is doing.
    #[test]
    fn progress_notes_do_not_disturb_the_status() {
        let mut log = RunLog::default();
        log.push(user("go"));
        log.push(AgentEvent::AwaitingPermission {
            tool_use_id: "t1".to_string(),
        });
        log.push(AgentEvent::Status {
            text: "retrying".to_string(),
        });
        assert_eq!(log.status, RunStatus::AwaitingPermission);
    }
}
