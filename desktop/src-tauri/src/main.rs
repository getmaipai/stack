#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{path::PathBuf, thread, time::Duration};

use serde_json::Value;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Manager, Url, WebviewUrl,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::ShellExt;

const DAEMON_URL: &str = "http://127.0.0.1:8770";
const SERVICE_LABEL: &str = "com.maipai.stack";

#[tauri::command]
fn launch_agent_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/LaunchAgents")
        .join(format!("{SERVICE_LABEL}.plist"))
}

fn run_sidecar(app: &AppHandle, args: &[&str]) -> Result<(), String> {
    app.shell()
        .sidecar("maipai-stack")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_daemon(app: AppHandle) -> Result<(), String> {
    run_sidecar(&app, &["start-service"])
}

fn ensure_daemon(app: AppHandle) {
    thread::spawn({
        let app = app.clone();
        move || {
            if ureq::get(&format!("{DAEMON_URL}/healthz")).call().is_ok() {
                open_console(&app);
                return;
            }
            let args = if launch_agent_path().exists() {
                ["start-service"]
            } else {
                ["install-service"]
            };
            if run_sidecar(&app, &args).is_ok() {
                for _ in 0..30 {
                    if ureq::get(&format!("{DAEMON_URL}/healthz")).call().is_ok() {
                        open_console(&app);
                        break;
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }
    });
}

fn open_console(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(Url::parse(DAEMON_URL).expect("valid daemon URL"));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn post_run_state(state: &str) {
    let _ = ureq::post(&format!("{DAEMON_URL}/stack/v1/run-state"))
        .set("content-type", "application/json")
        .send_string(&format!(r#"{{"state":"{state}"}}"#));
}

fn get_json(path: &str) -> Option<Value> {
    ureq::get(&format!("{DAEMON_URL}{path}"))
        .call()
        .ok()?
        .into_string()
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
}

fn health_severity() -> String {
    if ureq::get(&format!("{DAEMON_URL}/healthz")).call().is_err() {
        return "offline".to_string();
    }
    let rank = |severity: &str| match severity {
        "critical" => 3,
        "error" => 2,
        "warning" => 1,
        _ => 0,
    };
    get_json("/stack/v1/health")
        .and_then(|body| body.get("health").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|item| item.get("severity").and_then(Value::as_str))
        .max_by_key(|severity| rank(severity))
        .unwrap_or("ok")
        .to_string()
}

fn icon_bytes(severity: &str) -> &'static [u8] {
    match severity {
        "critical" => include_bytes!("../icons/tray-critical.png"),
        "error" => include_bytes!("../icons/tray-error.png"),
        "warning" => include_bytes!("../icons/tray-warning.png"),
        "offline" => include_bytes!("../icons/tray-offline.png"),
        _ => include_bytes!("../icons/tray-ok.png"),
    }
}

fn set_tray_health(app: &AppHandle, severity: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(icon) = Image::from_bytes(icon_bytes(severity)) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(&format!("MaiPai Stack · {severity}")));
    }
}

fn status_text() -> (String, bool) {
    let Some(run_state) = get_json("/stack/v1/run-state") else {
        return ("Not running".to_string(), false);
    };
    if run_state.get("state").and_then(Value::as_str) == Some("paused") {
        return ("Paused".to_string(), true);
    }
    let body = get_json("/stack/v1/roles").unwrap_or(Value::Null);
    let labels = body
        .get("roles")
        .and_then(Value::as_array)
        .map(|roles| {
            roles
                .iter()
                .filter_map(|role| {
                    let state = role
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if matches!(state, "notInstalled" | "not installed" | "offline") {
                        return None;
                    }
                    let label = role.get("label").and_then(Value::as_str).unwrap_or("Role");
                    let word = if matches!(state, "ready" | "running") {
                        "ready"
                    } else if state == "paused" {
                        "paused"
                    } else {
                        "not ready"
                    };
                    Some(format!("{label} {word}"))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    (format!("Running · {}", labels.join(", ")), false)
}

fn poll_tray(app: AppHandle, status: MenuItem<tauri::Wry>, toggle: MenuItem<tauri::Wry>) {
    thread::spawn(move || {
        let mut previous = String::new();
        loop {
            let severity = health_severity();
            set_tray_health(&app, &severity);
            let (text, paused) = status_text();
            let _ = status.set_text(&text);
            let _ = toggle.set_text(if paused { "Resume" } else { "Pause" });
            if (severity == "critical" || severity == "error") && severity != previous {
                let _ = app
                    .notification()
                    .builder()
                    .title("MaiPai Stack health")
                    .body(format!("The Stack has a {severity} health item."))
                    .show();
            }
            previous = severity;
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn watch_events(app: AppHandle) {
    thread::spawn(move || {
        let mut last_seq = 0;
        loop {
            if let Ok(response) = ureq::get(&format!("{DAEMON_URL}/stack/v1/events")).call() {
                if let Ok(body) = response.into_string() {
                    for event in body.split("\n\n") {
                        let Some(data) = event
                            .lines()
                            .find(|line| line.starts_with("data: "))
                            .map(|line| &line[6..])
                        else {
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<Value>(data) else {
                            continue;
                        };
                        let sequence = value.get("seq").and_then(Value::as_i64).unwrap_or(0);
                        if sequence <= last_seq {
                            continue;
                        }
                        last_seq = sequence;
                        match value.get("id").and_then(Value::as_str) {
                            Some("update.available") => {
                                let _ = app
                                    .notification()
                                    .builder()
                                    .title("MaiPai Stack update")
                                    .body("An update is available.")
                                    .show();
                            }
                            Some("model.installed") => {
                                let _ = app
                                    .notification()
                                    .builder()
                                    .title("MaiPai Stack model")
                                    .body("A model was installed.")
                                    .show();
                            }
                            _ => {}
                        }
                    }
                }
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            open_console(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![start_daemon])
        .setup(|app| {
            let status = MenuItemBuilder::with_id("status", "Running · Chat ready")
                .enabled(false)
                .build(app)?;
            let open = MenuItemBuilder::with_id("open", "Open the Stack").build(app)?;
            let toggle = MenuItemBuilder::with_id("toggle", "Pause").build(app)?;
            let (_, paused) = status_text();
            toggle.set_text(if paused { "Resume" } else { "Pause" })?;
            let quit = MenuItemBuilder::with_id("quit", "Quit the app (the Stack keeps running)")
                .build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&status)
                .item(&toggle)
                .item(&open)
                .separator()
                .item(&quit)
                .build()?;
            let tray_icon = Image::from_bytes(icon_bytes("ok"))?;
            tauri::tray::TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("MaiPai Stack · ok")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => open_console(app),
                    "toggle" => {
                        let (_, paused) = status_text();
                        post_run_state(if paused { "running" } else { "paused" });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("fallback.html".into()))
                .title("MaiPai Stack")
                .inner_size(1200.0, 820.0)
                .min_inner_size(900.0, 620.0)
                .visible(false)
                .build()?;
            poll_tray(app.handle().clone(), status, toggle);
            watch_events(app.handle().clone());
            ensure_daemon(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
