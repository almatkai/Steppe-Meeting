use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "macos")]
use screencapturekit::prelude::*;

#[cfg(target_os = "macos")]
pub struct ActiveRecording {
    stream: SCStream,
    recording_output: SCRecordingOutput,
    output_path: PathBuf,
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub struct ActiveRecording {
    pub output_path: PathBuf,
}

pub struct RecorderState(pub Mutex<Option<ActiveRecording>>);

#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn check_screen_capture_permission() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn check_screen_capture_permission() -> bool {
    false
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn request_screen_capture_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn request_screen_capture_permission() -> bool {
    false
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn start_native_recording(
    record_mic: bool,
    state: State<'_, RecorderState>,
) -> Result<String, String> {
    let mut lock = state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock recorder state: {}", e))?;

    if lock.is_some() {
        return Err("Recording is already in progress".to_string());
    }
    if unsafe { !CGPreflightScreenCaptureAccess() } {
        return Err("PermissionNotGranted".to_string());
    }

    let content = SCShareableContent::get()
        .map_err(|e| format!("Failed to get shareable content (check Screen Recording permissions): {:?}", e))?;
    let display = content
        .displays()
        .first()
        .ok_or_else(|| "No display found to record audio from".to_string())?;
    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new()
        .with_width(128)
        .with_height(128)
        .with_captures_audio(true)
        .with_captures_microphone(record_mic)
        .with_excludes_current_process_audio(true);

    let output_path = std::env::temp_dir().join(format!(
        "steppe_meeting_{}.mp4",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    ));
    let recording_config = SCRecordingOutputConfiguration::new().with_output_url(&output_path);
    let recording = SCRecordingOutput::new(&recording_config)
        .ok_or_else(|| "Failed to create SCRecordingOutput on macOS".to_string())?;
    let stream = SCStream::new(&filter, &config);
    stream
        .add_recording_output(&recording)
        .map_err(|e| format!("Failed to add recording output: {:?}", e))?;
    stream
        .start_capture()
        .map_err(|e| format!("Failed to start capture: {:?}", e))?;

    let output_path_str = output_path.to_string_lossy().to_string();
    *lock = Some(ActiveRecording {
        stream,
        recording_output: recording,
        output_path,
    });
    Ok(output_path_str)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn start_native_recording(
    _record_mic: bool,
    _state: State<'_, RecorderState>,
) -> Result<String, String> {
    Err("Native ScreenCaptureKit recording is only supported on macOS. Web fallback is active.".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn stop_native_recording(state: State<'_, RecorderState>) -> Result<String, String> {
    let mut lock = state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock recorder state: {}", e))?;
    let recording = lock
        .take()
        .ok_or_else(|| "No active recording found".to_string())?;

    let _ = recording.stream.stop_capture();
    let _ = recording
        .stream
        .remove_recording_output(&recording.recording_output);
    let path_str = recording.output_path.to_string_lossy().to_string();
    let start_wait = std::time::Instant::now();
    let mut file_ready = false;
    while start_wait.elapsed() < std::time::Duration::from_secs(3) {
        if let Ok(metadata) = std::fs::metadata(&recording.output_path) {
            if metadata.len() > 0 {
                file_ready = true;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !file_ready && !Path::new(&path_str).exists() {
        return Err("Recorded file was not created or is empty".to_string());
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
    Ok(path_str)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn stop_native_recording(
    _state: State<'_, RecorderState>,
) -> Result<String, String> {
    Err("Native ScreenCaptureKit recording is only supported on macOS. Web fallback is active.".to_string())
}

#[tauri::command]
pub fn read_recording_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read recorded file: {}", e))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn open_screen_recording_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn open_screen_recording_settings() {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn test_sc_permission() {
        match SCShareableContent::get() {
            Ok(content) => println!("SUCCESS: found {} displays", content.displays().len()),
            Err(e) => println!("FAILED: {:?}", e),
        }
    }
}