mod agents;
mod commands;
mod db;
mod fs_ops;
mod git;
mod models;
mod search;
mod state;
mod terminal;
mod watcher;

use state::AppState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/** Rust panics don't go through `log::error!` on their own — this makes
 * sure one lands in the same on-disk log file `tauri-plugin-log` writes
 * to (`app.log_dir()`) before the default hook prints to stderr, which is
 * invisible once the app is launched from a `.desktop` entry / Dock icon
 * rather than a terminal. Installed once, at startup, ahead of anything
 * that could panic. `panic = "abort"` in the release profile means this
 * is often the *only* record a release-build crash leaves behind. */
fn install_panic_log_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_log_hook();
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
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: None },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::open(&app_data_dir)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                hook_cancel_senders: Mutex::new(HashMap::new()),
                watchers: Mutex::new(HashMap::new()),
                agent_status_cache: Mutex::new(HashMap::new()),
                agent_runs: Mutex::new(HashMap::new()),
                terminals: Mutex::new(HashMap::new()),
                search_cancel_flags: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::projects::list_projects,
            commands::projects::pick_project_folder,
            commands::projects::add_project,
            commands::projects::remove_project,
            commands::projects::rename_project,
            commands::worktrees::list_worktrees,
            commands::worktrees::list_project_branches,
            commands::worktrees::create_worktree,
            commands::worktrees::remove_worktree,
            commands::worktrees::touch_worktree,
            commands::hooks::get_hook_config,
            commands::hooks::set_hook_config,
            commands::hooks::get_global_hook_config,
            commands::hooks::set_global_hook_config,
            commands::hooks::run_worktree_hook,
            commands::hooks::cancel_worktree_hook,
            commands::files::list_dir,
            commands::files::read_file,
            commands::files::write_file,
            commands::attachments::save_pasted_attachment,
            commands::attachments::copy_file_into_attachments,
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
            commands::search::list_files,
            commands::search::search_in_files,
            commands::search::cancel_search,
            commands::search::replace_in_files,
            watcher::start_worktree_watcher,
            watcher::stop_worktree_watcher,
            commands::agents::detect_agent_cli,
            commands::agents::detect_all_agent_clis,
            commands::agents::set_agent_binary_path,
            commands::agents::generate_commit_message,
            commands::agents::list_agent_models,
            agents::sessions::list_resumable_sessions,
            agents::sessions::list_resumable_sessions_for_roots,
            agents::sessions::get_session_transcript,
            agents::slash_commands::list_slash_commands,
            agents::manager::start_agent_session,
            agents::manager::resume_agent_session,
            agents::manager::send_agent_message,
            agents::manager::respond_to_permission,
            agents::manager::set_permission_mode,
            agents::manager::interrupt_agent,
            agents::manager::kill_agent,
            agents::manager::kill_agent_runs_for_worktree,
            terminal::spawn_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::kill_terminal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Agent/terminal child processes are only reliably killed by
            // `kill_on_drop`/explicit `.kill()` calls we make ourselves —
            // this is the one place that fires on every quit path
            // (titlebar close, OS close, Cmd/Ctrl+Q), so it's the last
            // chance to sweep anything still running before the process
            // tree would otherwise be orphaned (docs/CHECKLIST.md).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                terminal::kill_all(&state);
                agents::manager::kill_all(&state);
            }
        });
}
