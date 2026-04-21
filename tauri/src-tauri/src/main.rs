#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{Manager, Emitter};
use serde::{Deserialize, Serialize};

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

// --- Auto-AFK ---

#[derive(Debug, Serialize, Deserialize, Clone)]
struct AutoAfkConfig {
    enabled: bool,
    screen_lock_enabled: bool,
    idle_enabled: bool,
    idle_timeout_seconds: u64,
}

impl Default for AutoAfkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            screen_lock_enabled: true,
            idle_enabled: true,
            idle_timeout_seconds: 180,
        }
    }
}

static LAST_AUTO_AFK_EMIT: AtomicU64 = AtomicU64::new(0);

fn read_auto_afk_config() -> AutoAfkConfig {
    if let Ok(home) = std::env::var("HOME") {
        let config_path = format!("{}/.chronicle/config.json", home);
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(afk) = config.get("auto_afk") {
                    if let Ok(cfg) = serde_json::from_value(afk.clone()) {
                        return cfg;
                    }
                }
            }
        }
    }
    AutoAfkConfig::default()
}

fn write_auto_afk_config(cfg: &AutoAfkConfig) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let config_path = format!("{}/.chronicle/config.json", home);
    let mut config: serde_json::Value = if let Ok(content) = std::fs::read_to_string(&config_path) {
        serde_json::from_str(&content).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };
    config["auto_afk"] = serde_json::to_value(cfg).map_err(|e| format!("Failed to serialize: {}", e))?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

fn emit_auto_afk(app: &tauri::AppHandle, reason: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let last = LAST_AUTO_AFK_EMIT.load(Ordering::Relaxed);
    if now - last < 60 {
        let _ = write_client_log(format!("[Auto-AFK] skipped (dedup, reason: {}, last emitted {}s ago)", reason, now - last));
        return;
    }
    let _ = write_client_log(format!("[Auto-AFK] emit triggered, reason: {}", reason));
    LAST_AUTO_AFK_EMIT.store(now, Ordering::Relaxed);

    // Directly call server API to end sessions
    if let Ok(server_url) = get_server_url() {
        let afk_url = format!("{}/api/afk", server_url);
        let _ = write_client_log(format!("[Auto-AFK] calling {} (reason: {})", afk_url, reason));
        // Use std::process::Command to curl for simplicity
        let output = std::process::Command::new("curl")
            .args(["-s", "-X", "POST", &afk_url])
            .output();
        match output {
            Ok(out) => {
                let status = String::from_utf8_lossy(&out.stdout);
                let _ = write_client_log(format!("[Auto-AFK] server response: {}", status.trim()));
            }
            Err(e) => {
                let _ = write_client_log(format!("[Auto-AFK] server call failed: {}", e));
            }
        }
    } else {
        let _ = write_client_log("[Auto-AFK] could not resolve server URL".to_string());
    }

    // Also emit event to frontend in case it's listening
    let _ = app.emit("auto-afk-triggered", reason);
}

#[tauri::command]
fn get_auto_afk_config() -> Result<AutoAfkConfig, String> {
    Ok(read_auto_afk_config())
}

#[tauri::command]
fn set_auto_afk_config(app: tauri::AppHandle, config: AutoAfkConfig) -> Result<(), String> {
    write_auto_afk_config(&config)?;
    // Restart idle checker if toggled on
    setup_idle_checker(&app, &config);
    Ok(())
}

// --- UI Language ---

#[tauri::command]
fn get_ui_language() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let config_path = format!("{}/.chronicle/config.json", home);
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ui) = config.get("ui").and_then(|u| u.get("language")) {
                if let Some(lang) = ui.as_str() {
                    return Ok(lang.to_string());
                }
            }
        }
    }
    Ok("auto".to_string())
}

#[tauri::command]
fn set_ui_language(language: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let config_path = format!("{}/.chronicle/config.json", home);
    let mut config: serde_json::Value = if let Ok(content) = std::fs::read_to_string(&config_path) {
        serde_json::from_str(&content).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };
    config["ui"]["language"] = serde_json::Value::String(language);
    let content = serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

// Screen lock detection via polling CGSession
#[cfg(target_os = "macos")]
fn setup_screen_lock_detection(app: &tauri::AppHandle) {
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let mut was_locked = false;
        let _ = write_client_log("[Auto-AFK] screen lock detection thread started".to_string());
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let config = read_auto_afk_config();
            if !config.enabled || !config.screen_lock_enabled {
                was_locked = false;
                continue;
            }
            let is_locked = is_screen_locked();
            let _ = write_client_log(format!("[Auto-AFK] screen lock check: is_locked={}, was_locked={}", is_locked, was_locked));
            if is_locked && !was_locked {
                let _ = write_client_log("[Auto-AFK] triggering AFK due to screen lock".to_string());
                emit_auto_afk(&app_handle, "screen-lock");
            }
            was_locked = is_locked;
        }
    });
}

#[cfg(target_os = "macos")]
fn is_screen_locked() -> bool {
    unsafe {
        use core_foundation_sys::base::{CFTypeRef, CFRelease};
        use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
        use core_foundation_sys::string::CFStringCreateWithBytes;
        use core_foundation_sys::number::{CFNumberGetValue, CFNumberRef, kCFNumberSInt64Type};
        use std::ffi::c_void;

        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
        }

        let dict_ref = CGSessionCopyCurrentDictionary();
        if dict_ref.is_null() {
            return false;
        }

        let key_bytes = b"CGSSessionScreenIsLocked";
        let key_ref = CFStringCreateWithBytes(
            std::ptr::null_mut(),
            key_bytes.as_ptr(),
            key_bytes.len() as isize,
            0x08000100u32,
            0,
        );
        if key_ref.is_null() {
            CFRelease(dict_ref as CFTypeRef);
            return false;
        }

        let value_ref = CFDictionaryGetValue(dict_ref, key_ref as *const c_void);
        CFRelease(key_ref as CFTypeRef);
        CFRelease(dict_ref as CFTypeRef);

        if value_ref.is_null() {
            return false;
        }

        let mut value: i64 = 0;
        let ok = CFNumberGetValue(
            value_ref as CFNumberRef,
            kCFNumberSInt64Type,
            &mut value as *mut i64 as *mut c_void,
        );
        if ok {
            value != 0
        } else {
            false
        }
    }
}

// Idle detection using system-idle-time crate
static IDLE_CHECKER_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn setup_idle_checker(app: &tauri::AppHandle, config: &AutoAfkConfig) {
    if !config.enabled || !config.idle_enabled {
        let _ = write_client_log(format!("[Auto-AFK] idle checker disabled: enabled={}, idle_enabled={}", config.enabled, config.idle_enabled));
        return;
    }
    if IDLE_CHECKER_STARTED.swap(true, Ordering::Relaxed) {
        return; // already running
    }

    let app_handle = app.clone();
    let timeout = config.idle_timeout_seconds;
    let _ = write_client_log(format!("[Auto-AFK] idle checker thread started, timeout={}s", timeout));

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let config = read_auto_afk_config();
            if !config.enabled || !config.idle_enabled {
                continue;
            }
            match system_idle_time::get_idle_time() {
                Ok(idle_duration) => {
                    let idle_secs = idle_duration.as_secs();
                    let _ = write_client_log(format!("[Auto-AFK] idle check: idle={}s, threshold={}s, timeout={}", idle_secs, config.idle_timeout_seconds, idle_secs >= config.idle_timeout_seconds));
                    if idle_duration >= Duration::from_secs(config.idle_timeout_seconds) {
                        let _ = write_client_log(format!("[Auto-AFK] triggering AFK due to idle ({}s)", idle_secs));
                        emit_auto_afk(&app_handle, "idle");
                    }
                }
                Err(e) => {
                    let _ = write_client_log(format!("[Auto-AFK] idle detection error: {}", e));
                }
            }
        }
    });
}

fn main() {
    init_client_log();

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            get_client_log,
            set_zoom,
            write_client_log,
            get_auto_afk_config,
            set_auto_afk_config,
            get_ui_language,
            set_ui_language,
        ])
        .setup(|app| {
            // Note: Cmd+Shift+T and Cmd+1/2/3 are now handled in-browser (not global shortcuts)
            // This allows other apps to use these shortcuts when Chronicle is not focused

            // Auto-AFK setup
            let config = read_auto_afk_config();
            let _ = write_client_log(format!("[Auto-AFK] config loaded: enabled={}, screen_lock={}, idle={}, timeout={}", config.enabled, config.screen_lock_enabled, config.idle_enabled, config.idle_timeout_seconds));
            if config.enabled {
                if config.screen_lock_enabled {
                    #[cfg(target_os = "macos")]
                    setup_screen_lock_detection(&app.handle());
                }
                setup_idle_checker(&app.handle(), &config);
            } else {
                let _ = write_client_log("[Auto-AFK] disabled, not starting detection threads".to_string());
            }

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
