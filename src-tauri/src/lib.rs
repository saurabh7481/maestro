mod agents;
mod commands;
mod daybook;
mod db;
mod fs_ops;
mod git;
mod git_remote;
mod lsp;
mod models;
mod process_ext;
mod processes;
mod relay;
mod search;
mod state;
mod terminal;
mod watcher;

use state::AppState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

fn make_app_state(conn: rusqlite::Connection, app_data_dir: std::path::PathBuf) -> AppState {
    AppState {
        db: Mutex::new(conn),
        pending_daybook_oauth_urls: Mutex::new(
            std::env::args()
                .filter(|arg| daybook::slack::is_slack_callback_url(arg))
                .collect(),
        ),
        app_data_dir,
        hook_runs: Mutex::new(HashMap::new()),
        agent_run_logs: Mutex::new(HashMap::new()),
        clone_runs: Mutex::new(HashMap::new()),
        watchers: Mutex::new(HashMap::new()),
        agent_status_cache: Mutex::new(HashMap::new()),
        lsp_status_cache: Mutex::new(HashMap::new()),
        lsp_servers: Mutex::new(HashMap::new()),
        agent_runs: Mutex::new(HashMap::new()),
        terminals: Mutex::new(HashMap::new()),
        search_cancel_flags: Mutex::new(HashMap::new()),
        opencode_sidecar: agents::opencode::OpencodeSidecar::new(),
        opencode_guards: Mutex::new(HashMap::new()),
        opencode_provider_cache: Mutex::new(None),
        opencode_recent_disconnects: Mutex::new(HashMap::new()),
        mcp_server_port: std::sync::OnceLock::new(),
    }
}

/// Entry point used by the OS user timer. It deliberately initializes no
/// webview and reads secrets only through the same keychain-backed source
/// adapters as a manual run.
pub async fn run_daybook_headless() -> Result<String, String> {
    let app_data_dir = dirs::data_dir()
        .ok_or_else(|| "Could not locate the user data directory.".to_string())?
        .join("dev.maestro.app");
    let conn = db::open(&app_data_dir).map_err(|error| error.to_string())?;
    let state = make_app_state(conn, app_data_dir);
    let config = {
        let conn = state.db.lock().map_err(|error| error.to_string())?;
        let (config, configured) = commands::daybook::read_config(&conn)?;
        if !configured || !config.enabled {
            return Err("Daybook scheduling is not enabled.".to_string());
        }
        config
    };
    let date = match config.schedule.mode {
        commands::daybook::DaybookScheduleMode::AfterDayEnds => chrono::Local::now()
            .date_naive()
            .pred_opt()
            .ok_or_else(|| "Could not resolve the previous day.".to_string())?,
        commands::daybook::DaybookScheduleMode::DaySoFar => chrono::Local::now().date_naive(),
    };
    let result = commands::daybook::run_daybook_now_inner(
        &state,
        commands::daybook::DaybookRunRequest {
            date: Some(date.format("%Y-%m-%d").to_string()),
            config,
        },
        "scheduled",
    )
    .await?;
    // `main.rs` prints this and exits 0. A skipped run has no path and is
    // still a success — exiting non-zero would mark the systemd unit
    // failed for a day that simply had no activity.
    Ok(result
        .output_path
        .unwrap_or_else(|| format!("Skipped {}: no activity to record.", result.date)))
}

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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut pending) = state.pending_daybook_oauth_urls.lock() {
                    pending.extend(
                        args.into_iter()
                            .filter(|arg| daybook::slack::is_slack_callback_url(arg)),
                    );
                }
            }
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Linux has no installer-owned URI registration step for
                // AppImages. Register the static `maestro` scheme against
                // the stable AppImage path on startup so Slack's browser
                // callback reaches this (or the single) running instance.
                app.deep_link().register_all()?;
            }
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::open(&app_data_dir)?;
            app.manage(make_app_state(conn, app_data_dir));
            // Starts off; `relay::restore_persisted` below brings it back
            // up if the Settings "Enable Remote Access" toggle was last
            // left on (`relay::mod.rs`'s `RELAY_ENABLED_SETTING_KEY`) —
            // without it, a device paired earlier would silently lose its
            // connection on every desktop restart, not just when the user
            // actually meant to turn remote access off. A fresh install
            // has no stored value and stays off.
            app.manage(relay::RelayState::default());
            let relay_app = app.handle().clone();
            tauri::async_runtime::spawn(relay::restore_persisted(relay_app));

            // Started before the app finishes setup so the port is always
            // set by the time any agent turn can spawn (`agents/manager.rs`
            // reads `AppState::mcp_server_port` when building `TurnCtx`).
            let mcp_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match agents::mcp_tools::spawn_mcp_server(mcp_app.clone()).await {
                    Ok(port) => {
                        let _ = mcp_app.state::<AppState>().mcp_server_port.set(port);
                        log::info!("Local MCP tool server listening on 127.0.0.1:{port}");
                        agents::mcp_registration::sync(&mcp_app, Some(port)).await;
                    }
                    Err(error) => {
                        log::error!("Failed to start the local MCP tool server: {error}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::projects::list_projects,
            commands::projects::pick_project_folder,
            commands::projects::add_project,
            commands::projects::clone_project,
            commands::projects::cancel_project_clone,
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
            commands::worktree_settings::get_worktree_settings,
            commands::worktree_settings::set_worktree_settings,
            commands::worktree_settings::get_global_worktree_settings,
            commands::worktree_settings::set_global_worktree_settings,
            commands::files::list_dir,
            commands::files::read_file,
            commands::files::write_file,
            commands::attachments::save_pasted_attachment,
            commands::attachments::copy_file_into_attachments,
            commands::attachments::pick_attachment_files,
            commands::daybook::get_daybook_overview,
            commands::daybook::list_daybook_runs,
            commands::daybook::save_daybook_config,
            commands::daybook::set_daybook_schedule_enabled,
            commands::daybook::preview_daybook_inputs,
            commands::daybook::run_daybook_now,
            commands::daybook::pick_daybook_destination,
            commands::daybook::begin_daybook_slack_oauth,
            commands::daybook::poll_daybook_slack_oauth,
            commands::daybook::disconnect_daybook_slack,
            commands::daybook::import_daybook_jira_environment,
            commands::daybook::forget_daybook_jira_credentials,
            commands::files::create_entry,
            commands::files::rename_entry,
            commands::files::delete_entry,
            commands::files::get_status_map,
            commands::git::get_working_status,
            commands::git::stage_paths,
            commands::git::stage_all,
            commands::git::unstage_paths,
            commands::git::unstage_all,
            commands::git::stage_hunk,
            commands::git::discard_change,
            commands::git::discard_paths,
            commands::git::commit_changes,
            commands::git::push_changes,
            commands::git::pull_changes,
            commands::git::fetch_remote,
            commands::git::get_diff_content,
            commands::git::get_blame,
            commands::git::get_commit_log,
            commands::git::get_commit_files,
            commands::git::get_conflict_content,
            commands::git::resolve_conflict,
            commands::git::list_stashes,
            commands::git::create_stash,
            commands::git::apply_stash,
            commands::git::drop_stash,
            commands::git::get_stash_files,
            commands::git::checkout_branch,
            commands::git::create_branch,
            commands::git::delete_branch,
            commands::search::list_files,
            commands::search::search_in_files,
            commands::search::cancel_search,
            commands::search::replace_in_files,
            commands::search::preview_replace_lines,
            watcher::start_worktree_watcher,
            watcher::watch_worktree_directory,
            watcher::stop_worktree_watcher,
            commands::agents::detect_agent_cli,
            commands::agents::detect_all_agent_clis,
            commands::agents::set_agent_binary_path,
            commands::agents::generate_commit_message,
            commands::agents::list_agent_models,
            commands::agents::get_mcp_tools_enabled,
            commands::agents::set_mcp_tools_enabled,
            commands::updates::list_releases,
            commands::updates::revert_to_version,
            commands::aider::list_aider_providers,
            commands::aider::save_aider_provider,
            commands::aider::forget_aider_provider,
            commands::aider::aider_keychain_status,
            commands::opencode::opencode_sidecar_status,
            commands::opencode::opencode_sidecar_acquire,
            commands::opencode::opencode_sidecar_release,
            commands::opencode::opencode_list_providers,
            commands::opencode::opencode_provider_auth_methods,
            commands::opencode::opencode_connect_with_key,
            commands::opencode::opencode_begin_oauth,
            commands::opencode::opencode_oauth_status,
            commands::opencode::opencode_disconnect,
            commands::lsp::get_global_lsp_settings,
            commands::lsp::set_global_lsp_settings,
            commands::lsp::get_project_lsp_settings,
            commands::lsp::set_project_lsp_settings,
            commands::lsp::is_lsp_enabled_for_worktree,
            commands::lsp::detect_lsp_server,
            commands::lsp::detect_all_lsp_servers,
            commands::lsp::set_lsp_binary_path,
            commands::lsp::get_typescript_sdk_path,
            commands::lsp::set_typescript_sdk_path,
            commands::lsp::start_lsp_server,
            commands::lsp::send_lsp_message,
            commands::lsp::send_lsp_messages,
            commands::lsp::stop_lsp_server,
            commands::lsp::list_running_lsp_servers,
            agents::sessions::list_resumable_sessions,
            agents::sessions::list_all_resumable_sessions,
            agents::sessions::list_resumable_sessions_for_roots,
            agents::sessions::get_session_transcript,
            agents::sessions::export_session_markdown,
            agents::session_overrides::set_session_title,
            agents::session_overrides::set_session_pinned,
            agents::session_overrides::delete_resumable_session,
            agents::slash_commands::list_slash_commands,
            agents::transcripts::save_agent_transcript,
            agents::transcripts::load_agent_transcript,
            agents::transcripts::delete_agent_transcript,
            agents::transcripts::prune_agent_transcripts,
            agents::manager::start_agent_session,
            agents::manager::resume_agent_session,
            agents::manager::send_agent_message,
            agents::manager::respond_to_permission,
            agents::manager::set_permission_mode,
            agents::manager::fork_agent_session,
            agents::manager::set_agent_configuration,
            agents::manager::get_agent_configuration,
            agents::manager::interrupt_agent,
            agents::manager::kill_agent,
            agents::manager::kill_agent_runs_for_worktree,
            processes::list_managed_processes,
            processes::kill_managed_process,
            relay::set_relay_enabled,
            relay::check_funnel,
            relay::relay_status,
            relay::pairing::create_pairing_code,
            relay::devices::list_paired_devices,
            relay::devices::revoke_device,
            relay::devices::delete_device,
            relay::devices::set_device_access,
            relay::devices::rename_device,
            terminal::spawn_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::kill_terminal,
            terminal::open_system_terminal,
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
                lsp::kill_all(&state);
                // The opencode sidecar is the one long-lived server this
                // app owns — quitting without this would orphan a ~366 MB
                // process (docs/OPENCODE_INTEGRATION.md §2.2).
                state.opencode_sidecar.shutdown_now();
            }
        });
}
