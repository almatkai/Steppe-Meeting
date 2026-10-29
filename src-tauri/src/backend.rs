//! Own only the backend process started by this application. An existing server
//! is reusable only when its health endpoint identifies the same backend source.
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

fn stop_owned(child: &mut Child) {
    // The launcher and setup subprocesses have their own process group. Never
    // signal a reused server or the application's process group.
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGTERM);
        }
        // Let FastAPI cancel its generation jobs and clean up their separate
        // CLI process groups before escalating a stuck launcher/backend.
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Default)]
pub struct BackendState {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

impl BackendState {
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut owned) = self.child.lock() {
            if let Some(mut child) = owned.take() {
                stop_owned(&mut child);
            }
        }
    }
}

fn backend_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let directory = select_backend_dir(&resources, cfg!(debug_assertions));
    directory.canonicalize().map_err(|_| {
        "Не найдены файлы локального сервера. Пересоберите приложение через ./run_app.sh.".into()
    })
}

fn select_backend_dir(resources: &Path, development: bool) -> PathBuf {
    if development {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend");
        if source.join("desktop_server.py").is_file() {
            return source;
        }
    }
    resources.join("backend")
}

fn health(expected: &Path) -> Result<bool, String> {
    let address: SocketAddr = format!("127.0.0.1:{}", crate::updater::api_port())
        .parse()
        .unwrap();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return Ok(false);
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(700)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(700)))
        .map_err(|e| e.to_string())?;
    stream.write_all(b"GET /api/v1/system/health HTTP/1.1\r\nHost: 127.0.0.1:8008\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut response = String::new();
    // Bound the read: port 8008 could belong to a different local service.
    if stream.take(8192).read_to_string(&mut response).is_ok() {
        if let Some((headers, body)) = response.split_once("\r\n\r\n") {
            if headers.starts_with("HTTP/1.1 200") || headers.starts_with("HTTP/1.0 200") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
                    if value["service"] == "steppe-meeting" {
                        if compatible_identity(&value, expected, cfg!(debug_assertions)) {
                            return Ok(true);
                        }
                        return Err("На порту 8008 работает другая копия Steppe Meeting. Закройте её и повторите подключение.".into());
                    }
                }
            }
        }
    }
    Err("Порт 8008 занят сервером без совместимой проверки готовности. Остановите старый сервер и повторите подключение.".into())
}

fn compatible_identity(value: &serde_json::Value, expected: &Path, development: bool) -> bool {
    value["backend_dir"].as_str().map(Path::new) == Some(expected)
        && (development
            || (value["app_version"] == crate::updater::native_version()
                && value["runtime"] == "bundled"))
}

fn start(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    let mut owned = state.child.lock().map_err(|e| e.to_string())?;
    let directory = backend_dir(&app)?;
    if health(&directory)? {
        return Ok(());
    }
    if let Some(mut child) = owned.take() {
        stop_owned(&mut child);
    }
    #[cfg(not(feature = "packaged-updater-fixture"))]
    let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
    #[cfg(feature = "packaged-updater-fixture")]
    let logs = crate::updater::fixture_root().join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log_path = logs.join("backend.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new("/bin/bash");
    #[cfg(unix)]
    command.process_group(0);
    let mut token_bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut token_bytes))
        .map_err(|e| e.to_string())?;
    let token: String = token_bytes.iter().map(|b| format!("{b:02x}")).collect();
    *app.state::<crate::updater::UpdateState>()
        .token
        .lock()
        .map_err(|e| e.to_string())? = token.clone();
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(bundle) = executable
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
    {
        let identity = Command::new("/bin/ps")
            .args([
                "-p",
                &std::process::id().to_string(),
                "-o",
                "lstart=",
                "-o",
                "comm=",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        command
            .env("STEPPE_NATIVE_APP", bundle)
            .env("STEPPE_NATIVE_PID", std::process::id().to_string())
            .env(
                "STEPPE_NATIVE_IDENTITY",
                String::from_utf8_lossy(&identity.stdout).trim(),
            );
    }
    command.env("STEPPE_NATIVE_UPDATE_TOKEN", token);
    #[cfg(feature = "packaged-updater-fixture")]
    command
        .env(
            "STEPPE_DATA_DIR",
            crate::updater::fixture_root().join("data"),
        )
        .env("DESKTOP_API_PORT", crate::updater::api_port().to_string());
    let mut child = command
        .arg(directory.join("run_backend.sh"))
        .env("STEPPE_APP_VERSION", crate::updater::native_version())
        // The script resolves its own directory. Start from a stable system
        // directory so shell initialization need not resolve a Desktop path.
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("Не удалось запустить локальный сервер: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if state.stopping.load(Ordering::SeqCst) {
            stop_owned(&mut child);
            return Err("Приложение завершает работу.".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            stop_owned(&mut child);
            return Err(format!(
                "Локальный сервер завершился ({status}). Подробности: {}",
                log_path.display()
            ));
        }
        match health(&directory) {
            Ok(true) => {
                *owned = Some(child);
                return Ok(());
            }
            Ok(false) => {}
            Err(error) => {
                stop_owned(&mut child);
                return Err(error);
            }
        }
        if Instant::now() >= deadline {
            stop_owned(&mut child);
            return Err(format!("Локальный сервер не запустился за 120 секунд. Повторите подключение. Подробности: {}", log_path.display()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn owned_backend_gets_time_for_graceful_cleanup() {
        use std::io::{BufRead, BufReader};
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'exit 0' TERM; printf 'ready\\n'; while :; do sleep 1; done",
            ])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        stop_owned(&mut child);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn production_uses_resources_even_when_checkout_exists() {
        let resources = Path::new("/Applications/Steppe Meeting.app/Contents/Resources");
        assert_eq!(
            select_backend_dir(resources, false),
            resources.join("backend")
        );
        assert!(select_backend_dir(resources, true)
            .join("desktop_server.py")
            .is_file());
    }

    #[test]
    fn production_rejects_previous_version_and_development_runtime() {
        let expected = Path::new("/Example.app/Contents/Resources/backend");
        let mut identity = serde_json::json!({
            "backend_dir": expected, "app_version": crate::updater::native_version(), "runtime": "bundled"
        });
        assert!(compatible_identity(&identity, expected, false));
        identity["runtime"] = "development".into();
        assert!(!compatible_identity(&identity, expected, false));
        identity["runtime"] = "bundled".into();
        identity["app_version"] = "0.1.0".into();
        assert!(!compatible_identity(&identity, expected, false));
        assert!(compatible_identity(&identity, expected, true));
        assert!(!compatible_identity(&identity, Path::new("/other"), true));
    }
}

#[tauri::command]
pub async fn ensure_backend(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start(app))
        .await
        .map_err(|e| e.to_string())?
}
