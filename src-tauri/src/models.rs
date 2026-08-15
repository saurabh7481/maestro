use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub branch: String,
    pub is_primary: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub changed_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookConfig {
    pub copy_env_files: bool,
    pub run_install_command: bool,
    pub install_command: Option<String>,
    pub symlink_node_modules: bool,
    pub custom_script_enabled: bool,
    pub custom_script: String,
    /// Project-scoped configs only — meaningless on the global config (see
    /// `commands/hooks.rs`), which is always the fallback and has no
    /// "overrides" of its own. When true, this project's own field values
    /// are used instead of the global config's for that project's
    /// worktrees. Defaults to `false` so a freshly-added project inherits
    /// the global config until the user explicitly opts a project out.
    #[serde(default)]
    pub override_enabled: bool,
}

impl Default for HookConfig {
    fn default() -> Self {
        Self {
            copy_env_files: true,
            run_install_command: true,
            install_command: None,
            symlink_node_modules: false,
            custom_script_enabled: false,
            custom_script: String::new(),
            override_enabled: false,
        }
    }
}
