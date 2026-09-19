#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{path::PathBuf, thread, time::Duration};

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, Url, WebviewUrl,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::ShellExt;

const DAEMON_URL: &str = "http://127.0.0.1:8770";
const SERVICE_LABEL: &str = "com.maipai.stack";

#[derive(Clone)]
struct TrayControls {
    status: MenuItem<tauri::Wry>,
    action: MenuItem<tauri::Wry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraySnapshot {
    signed_in: bool,
    status: Option<String>,
    severity: Option<String>,
}

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

#[tauri::command]
fn set_tray_state(app: AppHandle, snapshot: TraySnapshot) {
    let controls = app.state::<TrayControls>();
    if !snapshot.signed_in {
        let _ = controls.status.set_text("Sign in");
        let _ = controls.action.set_text("Sign in");
        let _ = controls.action.set_enabled(true);
        set_tray_health(&app, "offline");
        return;
    }
    let status = snapshot.status.as_deref().unwrap_or("Starting");
    let _ = controls.status.set_text(status);
    let _ = controls.action.set_text(if status == "Paused" { "Resume" } else { "Pause" });
    let _ = controls.action.set_enabled(matches!(status, "Running" | "Paused"));
    set_tray_health(&app, snapshot.severity.as_deref().unwrap_or("ok"));
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

fn poll_tray(app: AppHandle) {
    thread::spawn(move || {
        loop {
            if ureq::get(&format!("{DAEMON_URL}/healthz")).call().is_err() {
                let controls = app.state::<TrayControls>();
                let _ = controls.status.set_text("Stopped");
                let _ = controls.action.set_enabled(false);
                set_tray_health(&app, "offline");
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
        .invoke_handler(tauri::generate_handler![start_daemon, set_tray_state])
        .setup(|app| {
            let status = MenuItemBuilder::with_id("status", "Starting")
                .enabled(false)
                .build(app)?;
            let open = MenuItemBuilder::with_id("open", "Open the Stack").build(app)?;
            let action = MenuItemBuilder::with_id("action", "Pause").enabled(false).build(app)?;
            let reload = MenuItemBuilder::with_id("reload", "Reload").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&status)
                .item(&action)
                .item(&open)
                .item(&reload)
                .item(&quit)
                .build()?;
            app.manage(TrayControls { status: status.clone(), action: action.clone() });
            let tray_icon = Image::from_bytes(icon_bytes("ok"))?;
            tauri::tray::TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("MaiPai Stack · ok")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => open_console(app),
                    "action" => {
                        if action.text().ok().as_deref() == Some("Sign in") { open_console(app); }
                        else { let _ = app.emit_to("main", "tray-action", "toggle"); }
                    }
                    "reload" => { if let Some(window) = app.get_webview_window("main") { let _ = window.eval("window.location.reload()"); } }
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
            poll_tray(app.handle().clone());
            ensure_daemon(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
