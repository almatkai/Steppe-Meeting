//! Own only the backend process started by this application. An existing server
//! is reusable only when its health endpoint identifies the same backend source.
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
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn backend_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend");
    let directory = if source.join("desktop_server.py").is_file() {
        source
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("backend")
    };
    directory.canonicalize().map_err(|_| {
        "Не найдены файлы локального сервера. Пересоберите приложение через ./run_app.sh.".into()
    })
}

fn health(expected: &Path) -> Result<bool, String> {
    let address: SocketAddr = "127.0.0.1:8008".parse().unwrap();
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
                        if value["backend_dir"].as_str().map(Path::new) == Some(expected) {
                            return Ok(true);
                        }
                        return Err("На порту 8008 работает Steppe Meeting из другого checkout. Остановите тот сервер и повторите подключение.".into());
                    }
                }
            }
        }
    }
    Err("Порт 8008 занят сервером без совместимой проверки готовности. Остановите старый сервер и повторите подключение.".into())
}

fn start(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    let mut owned = state.child.lock().map_err(|e| e.to_string())?;
    let directory = backend_dir(&app)?;
    if health(&directory)? {
        return Ok(());
    }
    if let Some(mut child) = owned.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log_path = logs.join("backend.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut child = Command::new("/bin/bash")
        .arg(directory.join("run_backend.sh"))
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
            let _ = child.kill();
            let _ = child.wait();
            return Err("Приложение завершает работу.".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
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
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Локальный сервер не запустился за 120 секунд. Повторите подключение. Подробности: {}", log_path.display()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[tauri::command]
pub async fn ensure_backend(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start(app))
        .await
        .map_err(|e| e.to_string())?
}
