mod commands;
mod db;
mod git;
mod models;
mod state;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
