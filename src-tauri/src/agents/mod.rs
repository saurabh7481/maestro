pub mod adapter;
pub mod claude;
pub mod codex;
pub mod cursor_agent;
pub mod events;
pub mod manager;
pub mod one_shot;
pub mod registry;
pub mod sessions;
pub mod slash_commands;

pub use registry::{AgentKind, CliStatus};
