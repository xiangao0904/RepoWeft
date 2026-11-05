mod accounts;
mod avatars;
mod git;
mod oauth;
mod ssh;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(code) = accounts::credential_entry() {
        std::process::exit(code);
    }
    // OpenSSH spawns this binary again to collect a password for the connection.
    if let Some(code) = ssh::askpass_entry() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(tauri::include_image!("icons/128x128@2x.png"))?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(git::GitState::default())
        .manage(terminal::TerminalState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                use tauri::Manager;
                window.state::<terminal::TerminalState>().close_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            oauth::github_oauth_configuration,
            oauth::github_oauth_login,
            oauth::github_oauth_cancel,
            accounts::account_repository_get,
            accounts::account_repository_set,
            accounts::account_use_pat,
            accounts::accounts_list,
            accounts::account_connect,
            accounts::account_select,
            accounts::account_remove,
            git::repository_snapshot,
            git::repository_log,
            git::repository_detail,
            git::repository_diff,
            git::repository_action,
            git::repository_create,
            git::repository_create_remote,
            git::ssh_config_hosts,
            git::ssh_test,
            git::ssh_directories,
            git::ssh_connect,
            git::ssh_trust,
            git::ssh_host_key,
            git::ssh_password_saved,
            git::ssh_reuse_enabled,
            git::ssh_forget_password,
            avatars::github_commit_avatar,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_ack,
            terminal::terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
