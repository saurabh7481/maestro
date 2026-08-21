//! OpenCode integration — the fifth wrapped agent CLI, and the only one
//! backed by a long-lived server process rather than per-turn spawns
//! alone (docs/OPENCODE_INTEGRATION.md §1).
//!
//! Module map:
//! - [`sidecar`] — the lazy `opencode serve` supervisor. Started only
//!   when an opencode consumer acquires it, stopped after a short idle
//!   grace, because a measured idle server costs ~366 MB RSS — more than
//!   the rest of Maestro combined. Nothing outside opencode features may
//!   ever cause it to spawn.
//! - [`client`] — the loopback HTTP client every opencode feature talks
//!   through, carrying the per-boot basic-auth password. Provider keys
//!   exist in server responses (Phase O1 finding) and must never cross
//!   IPC raw; projection happens above this layer.
//!
//! The turn adapter itself lands with Phase O5 in this module.

// Phase O2 deliberately ships the supervisor ahead of its consumers:
// acquire() gains callers in O3 (detection cross-check) / O4 (provider
// pane) / O5 (turns). Until then the lib target sees unused entry points,
// which is the plan working as written, not drift.
#![allow(dead_code)]

pub mod auth;
pub mod client;
pub mod providers;
pub mod sidecar;
pub mod turn;

pub use sidecar::{OpencodeSidecar, SidecarGuard, SidecarStatus};
pub use turn::{build_turn, finish, parse_line};
