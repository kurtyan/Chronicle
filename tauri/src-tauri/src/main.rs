#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use tauri::{Manager, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, Modifiers, Code, ShortcutState};

#[tauri::command]
fn get_server_url() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let config_path = format!("{}/.chronicle/config.json", home);
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;
    let host = config["lauri"]["serverHost"].as_str().unwrap_or("localhost");
    let port = config["lauri"]["serverPort"].as_u64().unwrap_or(8080);
    Ok(format!("http://{}:{}", host, port))
}

#[tauri::command]
fn get_client_log() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let log_path = format!("{}/.chronicle/logs/client.log", home);
    std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read log: {}", e))
}

fn init_client_log() {
    if let Ok(home) = std::env::var("HOME") {
        let log_dir = format!("{}/.chronicle/logs", home);
        let _ = create_dir_all(&log_dir);
        let log_path = format!("{}/client.log", log_dir);
        // Truncate existing log
        if let Ok(mut f) = OpenOptions::new().create(true).write(true).truncate(true).open(&log_path) {
            let _ = writeln!(f, "Chronicle client log initialized");
        }
    }
}

#[tauri::command]
fn set_zoom(app_handle: tauri::AppHandle, scale: f64) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.set_zoom(scale.max(0.5).min(3.0));
    }
    Ok(())
}

#[tauri::command]
fn write_client_log(message: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let log_path = format!("{}/.chronicle/logs/client.log", home);
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log: {}", e))?;
    writeln!(f, "{}", message)
        .map_err(|e| format!("Failed to write log: {}", e))
}

fn main() {
    init_client_log();

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::default().build())
        .invoke_handler(tauri::generate_handler![get_server_url, get_client_log, set_zoom, write_client_log])
        .setup(|app| {
            // Register Cmd+Shift+T global shortcut for Take Over
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyT);
            app.global_shortcut().on_shortcut(shortcut, |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = _app.emit("global-shortcut-takeover", ());
                }
            }).ok();

            let window = app.get_webview_window("main").unwrap();

            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Prevent Cmd+W (and also Cmd+Q / close button) from closing the window.
                    // Users should use the app's own exit mechanism.
                    api.prevent_close();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
