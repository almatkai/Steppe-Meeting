mod recorder;

use recorder::{
    check_screen_capture_permission, open_screen_recording_settings, read_recording_file,
    request_screen_capture_permission, start_native_recording, stop_native_recording,
    RecorderState,
};
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RecorderState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_native_recording,
            stop_native_recording,
            read_recording_file,
            open_screen_recording_settings,
            check_screen_capture_permission,
            request_screen_capture_permission,
        ])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
