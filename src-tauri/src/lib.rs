mod backend;
mod mini_capture;
mod recorder;

use recorder::{
    check_screen_capture_permission, open_microphone_settings, open_screen_recording_settings,
    read_recording_file, request_screen_capture_permission, start_native_recording,
    stop_native_recording, RecorderState,
};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct MiniRestoreShortcut(bool);

fn ensure_window_on_screen(window: &tauri::Window) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let visible = monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let bounds = monitor.size();
        position.x >= origin.x
            && position.y >= origin.y
            && i64::from(position.x) + i64::from(size.width)
                <= i64::from(origin.x) + i64::from(bounds.width)
            && i64::from(position.y) + i64::from(size.height)
                <= i64::from(origin.y) + i64::from(bounds.height)
    });
    if !visible {
        if let Some(monitor) = window.primary_monitor().map_err(|e| e.to_string())? {
            let origin = monitor.position();
            let bounds = monitor.size();
            let x = origin.x
                + (i64::from(bounds.width).saturating_sub(i64::from(size.width)) / 2).max(0) as i32;
            let y = origin.y
                + (i64::from(bounds.height).saturating_sub(i64::from(size.height)) / 2).max(0)
                    as i32;
            window
                .set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let main_win = app.get_window("main").ok_or("Main window not found")?;
    ensure_window_on_screen(&main_win)?;
    main_win.show().map_err(|e| e.to_string())?;
    main_win.unminimize().map_err(|e| e.to_string())?;
    main_win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn show_mini_window(app: &tauri::AppHandle) -> Result<(), String> {
    let main_win = app.get_window("main").ok_or("Main window not found")?;
    let mini_win = app
        .get_webview("mini")
        .ok_or("Mini webview not found")?
        .window();

    // Only hide main after the separate window is successfully shown.
    ensure_window_on_screen(&mini_win)?;
    mini_win.show().map_err(|e| e.to_string())?;
    mini_win.set_focus().map_err(|e| e.to_string())?;
    if let Err(error) = main_win.hide() {
        let _ = mini_win.hide();
        return Err(error.to_string());
    }
    Ok(())
}

fn toggle_mini_window(app: &tauri::AppHandle) -> Result<(), String> {
    let mini_win = app
        .get_webview("mini")
        .ok_or("Mini webview not found")?
        .window();

    if mini_win.is_visible().unwrap_or(false) {
        mini_win.hide().map_err(|e| e.to_string())?;
    } else {
        show_mini_window(app)?;
    }
    Ok(())
}

#[tauri::command]
async fn open_mini_window(app: tauri::AppHandle) -> Result<(), String> {
    show_mini_window(&app)
}

#[tauri::command]
async fn hide_mini_window(webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != "mini" {
        return Err("Hiding is scoped to Mini".into());
    }
    if !webview.app_handle().state::<MiniRestoreShortcut>().0 {
        return Err("Не удалось зарегистрировать ⌘⇧M. Mini остаётся открытым, чтобы вы могли управлять записью.".into());
    }
    // Keep the same webview, microphone and caption queue alive while hidden.
    webview.window().hide().map_err(|e| e.to_string())
}

#[tauri::command]
async fn restore_main_window(
    app: tauri::AppHandle,
    meeting_id: Option<String>,
) -> Result<(), String> {
    let mini_win = app
        .get_webview("mini")
        .ok_or("Mini webview not found")?
        .window();
    show_main_window(&app)?;
    if let Some(id) = meeting_id {
        app.emit_to("main", "mini-recording-saved", id)
            .map_err(|e| e.to_string())?;
    }
    mini_win.hide().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_mini_capture_protection(
    webview: tauri::Webview,
    enabled: bool,
) -> Result<bool, String> {
    if webview.label() != "mini" {
        return Err("Capture protection is scoped to Mini".into());
    }
    let window = webview.window();
    let (tx, rx) = std::sync::mpsc::channel();
    let native_window = window.clone();
    let native_webview = webview.clone();
    window
        .run_on_main_thread(move || {
            #[cfg(target_os = "macos")]
            let result = if enabled
                && !mini_capture::read_mini_capture_protection(&native_window).unwrap_or(false)
            {
                mini_capture::renew_protected_mini(&native_webview).map(|_| ())
            } else {
                mini_capture::set_mini_capture_protection(&native_window, enabled)
            };
            #[cfg(not(target_os = "macos"))]
            let result = mini_capture::set_mini_capture_protection(&native_window, enabled);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "Capture protection update was interrupted".to_string())
    })
    .await
    .map_err(|e| e.to_string())???;
    #[cfg(target_os = "macos")]
    for _ in 0..10 {
        let (tx, rx) = std::sync::mpsc::channel();
        let native_window = webview.window();
        native_window
            .clone()
            .run_on_main_thread(move || {
                let _ = tx.send(mini_capture::read_mini_capture_protection(&native_window));
            })
            .map_err(|e| e.to_string())?;
        let actual = tauri::async_runtime::spawn_blocking(move || {
            rx.recv()
                .map_err(|_| "Capture protection readback was interrupted".to_string())
        })
        .await
        .map_err(|e| e.to_string())???;
        if actual == enabled {
            return Ok(actual);
        }
        tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(20))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    return Err("macOS did not confirm the requested capture protection".into());
    #[cfg(not(target_os = "macos"))]
    Ok(enabled)
}

#[tauri::command]
async fn set_mini_size(webview: tauri::Webview, width: f64, height: f64) -> Result<(), String> {
    if webview.label() != "mini" {
        return Err("Sizing is scoped to Mini".into());
    }
    webview
        .window()
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_mini_height(webview: tauri::Webview, height: f64) -> Result<(), String> {
    if webview.label() != "mini" {
        return Err("Height sizing is scoped to Mini".into());
    }
    webview
        .window()
        .set_size(tauri::LogicalSize::new(330.0, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_mini_captions_visible(webview: tauri::Webview, visible: bool) -> Result<(), String> {
    if webview.label() != "mini" {
        return Err("Caption sizing is scoped to Mini".into());
    }
    webview
        .window()
        .set_size(tauri::LogicalSize::new(
            330.0,
            if visible { 76.0 } else { 36.0 },
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn drag_mini_window(webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != "mini" {
        return Err("Dragging is scoped to Mini".into());
    }
    webview.window().start_dragging().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(RecorderState(Mutex::new(None)))
        .manage(backend::BackendState::default())
        .invoke_handler(tauri::generate_handler![
            backend::ensure_backend,
            start_native_recording,
            stop_native_recording,
            read_recording_file,
            open_screen_recording_settings,
            open_microphone_settings,
            check_screen_capture_permission,
            request_screen_capture_permission,
            open_mini_window,
            hide_mini_window,
            restore_main_window,
            set_mini_capture_protection,
            set_mini_captions_visible,
            set_mini_height,
            set_mini_size,
            drag_mini_window,
        ])
        .setup(|app| {
            if let Some(mini) = app.get_window("mini") {
                mini_capture::configure_mini_window(&mini).map_err(std::io::Error::other)?;
            }
            let shortcut =
                app.global_shortcut()
                    .on_shortcut("CommandOrControl+Shift+M", |app, _, event| {
                        if event.state == ShortcutState::Pressed {
                            if let Err(error) = toggle_mini_window(app) {
                                eprintln!("Could not toggle Mini: {error}");
                            }
                        }
                    });
            if let Err(error) = &shortcut {
                eprintln!("Could not register Mini restore shortcut: {error}");
            }
            app.manage(MiniRestoreShortcut(shortcut.is_ok()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            // Keep the app running on macOS even if all windows are hidden
            if code.is_none() {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            app_handle.state::<backend::BackendState>().stop();
        }
        tauri::RunEvent::Reopen { .. } => {
            let mini_visible = app_handle
                .get_window("mini")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);

            if !mini_visible {
                if let Err(error) = show_main_window(app_handle) {
                    eprintln!("Could not show main window on reopen: {error}");
                }
            } else if let Some(mini) = app_handle.get_window("mini") {
                let _ = mini.set_focus();
            }
        }
        _ => {}
    });
}
