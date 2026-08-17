pub mod adapter;
pub mod capabilities;
pub mod claude;
pub mod codex;
pub mod cursor_agent;
pub mod events;
pub mod manager;
pub mod one_shot;
pub mod registry;
pub mod sessions;
pub mod slash_commands;
pub mod transcripts;

pub use registry::{AgentKind, CliStatus};
