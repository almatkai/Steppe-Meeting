//! Installation authority exists only in local Tauri IPC and an owned backend.
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::TcpStream,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Default)]
pub struct UpdateState {
    pub installing: AtomicBool,
    pub capture_windows: Mutex<HashSet<String>>,
    pub token: Mutex<String>,
}

impl UpdateState {
    pub fn release_window(&self, label: &str) {
        if let Ok(mut owners) = self.capture_windows.lock() {
            owners.remove(label);
        }
    }
}

#[tauri::command]
pub fn set_update_capture_busy(webview: tauri::Webview, busy: bool) -> Result<(), String> {
    let app = webview.app_handle();
    let state = app.state::<UpdateState>();
    let mut windows = state
        .capture_windows
        .lock()
        .map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
    if state.installing.load(Ordering::SeqCst) {
        return Err("Приложение готовится к обновлению.".into());
    }
    if busy {
        windows.insert(webview.label().to_string());
    } else {
        windows.remove(webview.label());
    }
    Ok(())
}

pub fn native_version() -> &'static str {
    #[cfg(feature = "packaged-updater-fixture")]
    {
        env!("STEPPE_FIXTURE_VERSION")
    }
    #[cfg(not(feature = "packaged-updater-fixture"))]
    {
        env!("CARGO_PKG_VERSION")
    }
}

pub fn api_port() -> u16 {
    #[cfg(feature = "packaged-updater-fixture")]
    {
        return env!("STEPPE_FIXTURE_PORT").parse().expect("fixture port");
    }
    #[cfg(not(feature = "packaged-updater-fixture"))]
    {
        8008
    }
}

#[tauri::command]
pub fn updater_fixture(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    action: String,
    value: serde_json::Value,
) -> Result<(), String> {
    #[cfg(feature = "packaged-updater-fixture")]
    {
        let root = fixture_root();
        if action == "browser" {
            return webview
                .navigate(
                    format!("http://127.0.0.1:{}/fixture-origin", api_port())
                        .parse()
                        .unwrap(),
                )
                .map_err(|e| e.to_string());
        }
        if action == "exit" {
            app.exit(0);
            return Ok(());
        }
        if action != "report" {
            return Err("invalid fixture action".into());
        }
        let path = root.join(format!(
            "native-{}-{}-{}.json",
            std::process::id(),
            webview.label(),
            value["label"]
                .as_str()
                .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric()))
                .unwrap_or("unknown")
        ));
        std::fs::write(
            path,
            serde_json::to_vec(&serde_json::json!({
                "marker":"STEPPE_PACKAGED_UPDATER_FIXTURE_ONLY", "pid":std::process::id(),
                "version":native_version(), "tauri_version":app.package_info().version.to_string(), "url":webview.url().ok().map(|u|u.to_string()), "value":value
            }))
            .unwrap(),
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(feature = "packaged-updater-fixture"))]
    {
        let _ = (app, webview, action, value);
        Err("Fixture support is not compiled into this application.".into())
    }
}

#[cfg(feature = "packaged-updater-fixture")]
pub fn fixture_root() -> std::path::PathBuf {
    let root = std::path::PathBuf::from(env!("STEPPE_FIXTURE_ROOT"))
        .canonicalize()
        .expect("fixture root");
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    assert!(root.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(root.join("fixture-owner").is_file() && executable.starts_with(&root));
    root
}

fn request(token: &str, job_id: &str) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({"job_id": job_id}).to_string();
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", api_port()).parse().unwrap(),
        Duration::from_secs(2),
    )
    .map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(300)))
        .map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
    write!(stream, "POST /api/v1/system/updates/native-install HTTP/1.1\r\nHost: 127.0.0.1:8008\r\nConnection: close\r\nContent-Type: application/json\r\nX-Steppe-Native: {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
    let mut response = String::new();
    stream
        .take(65536)
        .read_to_string(&mut response)
        .map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or("Неполный ответ сервера обновлений.")?;
    if !head.starts_with("HTTP/1.1 200 ") {
        return Err("Сервер не разрешил установку обновления.".into());
    }
    serde_json::from_str(body).map_err(|_| "Не удалось связаться с установщиком.".to_string())
}

fn install_origin_allowed(development: bool, label: &str, url: &str) -> bool {
    !development && label == "main" && local_product_url(url)
}

fn local_product_url(url: &str) -> bool {
    url == "tauri://localhost"
        || url.starts_with("tauri://localhost/")
        || url.starts_with("https://tauri.localhost/")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destroyed_window_releases_only_its_capture_ownership() {
        let state = UpdateState::default();
        state
            .capture_windows
            .lock()
            .unwrap()
            .extend(["main".to_string(), "mini".to_string()]);
        state.installing.store(true, Ordering::SeqCst);
        state.release_window("mini");
        assert!(state.capture_windows.lock().unwrap().contains("main"));
        assert!(!state.capture_windows.lock().unwrap().contains("mini"));
        assert!(state.installing.load(Ordering::SeqCst));
    }

    // Compile-time-only fixture entry point. Production IPC and trust roots
    // have no runtime fake-source/install-path switch. Python fixtures create
    // and sign their own arm64 TEMP bundle and use an isolated data directory.
    #[test]
    fn isolated_native_fixture_flow() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let result = std::process::Command::new(root.join("backend/.venv/bin/python"))
            .args([
                "-m",
                "unittest",
                "discover",
                "-s",
                "backend/tests",
                "-p",
                "test_updater_macos.py",
                "-q",
            ])
            .current_dir(root)
            .output()
            .expect("isolated fixture interpreter");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn only_local_product_origin_can_install() {
        assert!(local_product_url("tauri://localhost/index.html"));
        assert!(local_product_url("tauri://localhost"));
        assert!(!local_product_url("tauri://localhost.evil"));
        assert!(local_product_url("https://tauri.localhost/index.html"));
        assert!(!local_product_url(
            "https://tauri.localhost.evil/index.html"
        ));
        assert!(!local_product_url("http://localhost:1420/"));
    }
    #[test]
    fn development_and_browser_origins_fail_closed() {
        assert!(!install_origin_allowed(
            true,
            "main",
            "tauri://localhost/index.html"
        ));
        assert!(!install_origin_allowed(
            false,
            "main",
            "http://localhost:1420/"
        ));
        assert!(!install_origin_allowed(
            false,
            "main",
            "http://127.0.0.1:18088/"
        ));
        assert!(!install_origin_allowed(
            false,
            "mini",
            "tauri://localhost/index.html"
        ));
        assert!(install_origin_allowed(
            false,
            "main",
            "tauri://localhost/index.html"
        ));
    }

    #[test]
    fn packaged_helper_protocol_matches_native_contract() {
        let helper = include_str!("../../backend/update_installer.py");
        assert!(helper.contains("HELPER_VERSION = 1"));
        assert!(helper.contains("'awaiting_exit'"));
        assert!(helper.contains("'STEPPE_UPDATE_RECEIPT='"));
    }
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    job_id: String,
) -> Result<serde_json::Value, String> {
    if !install_origin_allowed(
        cfg!(debug_assertions),
        webview.label(),
        &webview
            .url()
            .map_err(|_| "Не удалось связаться с установщиком.".to_string())?
            .to_string(),
    ) {
        return Err("Установка доступна только в установленном приложении.".into());
    }
    let state = app.state::<UpdateState>();
    {
        let windows = state
            .capture_windows
            .lock()
            .map_err(|_| "Не удалось связаться с установщиком.".to_string())?;
        if !windows.is_empty()
            || app
                .state::<crate::recorder::RecorderState>()
                .0
                .lock()
                .map_err(|_| "Не удалось связаться с установщиком.".to_string())?
                .is_some()
        {
            return Ok(
                serde_json::json!({"stage":"deferred", "busy":["recording"], "cancellable":false}),
            );
        }
        if state.installing.swap(true, Ordering::SeqCst) {
            #[cfg(feature = "packaged-updater-fixture")]
            std::fs::write(
                fixture_root().join("repeat-install.json"),
                br#"{"stage":"preparing"}"#,
            )
            .map_err(|e| e.to_string())?;
            return Ok(serde_json::json!({"stage":"preparing", "cancellable":false}));
        }
    }
    let token = state
        .token
        .lock()
        .map_err(|_| "Не удалось связаться с установщиком.".to_string())?
        .clone();
    let result = tauri::async_runtime::spawn_blocking(move || request(&token, &job_id))
        .await
        .map_err(|_| "Не удалось связаться с установщиком.".to_string());
    match result {
        Ok(Ok(value)) if value["stage"] == "awaiting_exit" => {
            app.exit(0);
            Ok(value)
        }
        other => {
            state.installing.store(false, Ordering::SeqCst);
            other?
        }
    }
}
