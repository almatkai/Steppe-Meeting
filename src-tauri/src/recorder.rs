//! Native meeting recorder.
//!
//! The macOS implementation captures system audio and the microphone through
//! ScreenCaptureKit. Other platforms get stubs that return an explanatory
//! error, because the frontend already falls back to the browser's
//! getDisplayMedia + getUserMedia path when native recording is unavailable.
//! Before this split the crate simply did not compile off macOS.

#[cfg(target_os = "macos")]
mod macos {
    use screencapturekit::prelude::*;
    use screencapturekit::recording_output::{SCRecordingOutput, SCRecordingOutputConfiguration};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use tauri::State;

    pub struct ActiveRecording {
        stream: SCStream,
        recording_output: SCRecordingOutput,
        output_path: PathBuf,
    }

    // Global or managed state for recording
    pub struct RecorderState(pub Mutex<Option<ActiveRecording>>);

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

        // 1. Get displays to capture system audio from the active display
        let content = SCShareableContent::get()
            .map_err(|e| format!("Failed to get shareable content (check Screen Recording permissions): {:?}", e))?;

        let displays = content.displays();
        let display = displays
            .first()
            .ok_or_else(|| "No display found to record audio from".to_string())?;

        // 2. Create content filter
        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build();

        // 3. Configure stream with minimal dummy dimensions, audio enabled, mic enabled
        let config = SCStreamConfiguration::new()
            .with_width(128)
            .with_height(128)
            .with_captures_audio(true)
            .with_captures_microphone(record_mic)
            .with_excludes_current_process_audio(true);

        // 4. Output path in temporary directory
        let temp_dir = std::env::temp_dir();
        let filename = format!(
            "steppe_meeting_{}.mp4",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        );
        let output_path = temp_dir.join(filename);

        // 5. Configure recording output
        let rec_config = SCRecordingOutputConfiguration::new()
            .with_output_url(&output_path);

        let recording = SCRecordingOutput::new(&rec_config)
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

    #[tauri::command]
    pub fn stop_native_recording(state: State<'_, RecorderState>) -> Result<String, String> {
        let mut lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock recorder state: {}", e))?;

        let recording = lock
            .take()
            .ok_or_else(|| "No active recording found".to_string())?;

        // Stop capture
        let _ = recording.stream.stop_capture();
        let _ = recording
            .stream
            .remove_recording_output(&recording.recording_output);

        let path_str = recording.output_path.to_string_lossy().to_string();

        // Verify file exists
        if !Path::new(&path_str).exists() {
            return Err("Recorded file was not created".to_string());
        }

        Ok(path_str)
    }

    #[tauri::command]
    pub fn read_recording_file(path: String) -> Result<Vec<u8>, String> {
        std::fs::read(&path).map_err(|e| format!("Failed to read recorded file: {}", e))
    }

}

#[cfg(target_os = "macos")]
pub use macos::{read_recording_file, start_native_recording, stop_native_recording, RecorderState};

// --- Non-macOS stubs -------------------------------------------------------

#[cfg(not(target_os = "macos"))]
mod fallback {
    use std::sync::Mutex;
    use tauri::State;

    /// Kept so `lib.rs` can `manage` the same state type on every platform.
    pub struct ActiveRecording;
    pub struct RecorderState(pub Mutex<Option<ActiveRecording>>);

    const UNSUPPORTED: &str =
        "Native system-audio recording is only available on macOS. \
         Use the in-app recorder, which captures audio through the browser.";

    #[tauri::command]
    pub fn start_native_recording(
        _record_mic: bool,
        _state: State<'_, RecorderState>,
    ) -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub fn stop_native_recording(_state: State<'_, RecorderState>) -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub fn read_recording_file(path: String) -> Result<Vec<u8>, String> {
        std::fs::read(&path).map_err(|e| format!("Failed to read recorded file: {}", e))
    }
}

#[cfg(not(target_os = "macos"))]
pub use fallback::{read_recording_file, start_native_recording, stop_native_recording, RecorderState};
