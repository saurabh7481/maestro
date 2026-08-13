mod commands;
mod db;
mod fs_ops;
mod git;
mod models;
mod state;
mod watcher;

use state::AppState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::open(&app_data_dir)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                hook_cancel_senders: Mutex::new(HashMap::new()),
                watchers: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::projects::list_projects,
            commands::projects::pick_project_folder,
            commands::projects::add_project,
            commands::projects::remove_project,
            commands::worktrees::list_worktrees,
            commands::worktrees::list_project_branches,
            commands::worktrees::create_worktree,
            commands::worktrees::remove_worktree,
            commands::worktrees::touch_worktree,
            commands::hooks::get_hook_config,
            commands::hooks::set_hook_config,
            commands::hooks::run_worktree_hook,
            commands::hooks::cancel_worktree_hook,
            commands::files::list_dir,
            commands::files::read_file,
            commands::files::write_file,
            commands::files::create_entry,
            commands::files::rename_entry,
            commands::files::delete_entry,
            commands::files::get_status_map,
            commands::git::get_working_status,
            commands::git::stage_paths,
            commands::git::stage_all,
            commands::git::unstage_paths,
            commands::git::unstage_all,
            commands::git::discard_change,
            commands::git::commit_changes,
            commands::git::push_changes,
            commands::git::pull_changes,
            commands::git::fetch_remote,
            commands::git::get_diff_content,
            commands::git::get_commit_log,
            commands::git::get_commit_files,
            watcher::start_worktree_watcher,
            watcher::stop_worktree_watcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
