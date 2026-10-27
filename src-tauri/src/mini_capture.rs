use tauri::{Manager, Webview, Window};

pub fn configure_mini_window(window: &Window) -> Result<(), String> {
    window.set_always_on_top(true).map_err(|e| e.to_string())?;

    // 2. macOS Cocoa specific APIs
    #[cfg(target_os = "macos")]
    {
        use objc2::{msg_send, runtime::AnyObject};

        if let Ok(ns_win) = window.ns_window() {
            let win = ns_win.cast::<AnyObject>();
            unsafe {
                // Remove window shadow to prevent ghost borders when transparent
                let () = msg_send![win, setHasShadow: false];

                // Ensure it floats above all normal spaces and fullscreen apps
                // NSWindowCollectionBehaviorCanJoinAllSpaces (1 << 0) | NSWindowCollectionBehaviorFullScreenAuxiliary (1 << 8)
                let behavior: usize = (1 << 0) | (1 << 8);
                let () = msg_send![win, setCollectionBehavior: behavior];

                // NSFloatingWindowLevel = 3 or NSPopUpMenuWindowLevel = 101
                let () = msg_send![win, setLevel: 101isize];
            }
        }
    }
    set_mini_capture_protection(window, true)?;
    Ok(())
}

/// Apply capture protection on the main thread. Readback is separate because
/// WindowServer may commit the change after this AppKit call returns.
/// Capture behavior must be tested against each OS/recorder, not inferred from a badge.
pub fn set_mini_capture_protection(window: &Window, stealth: bool) -> Result<(), String> {
    window
        .set_content_protected(stealth)
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        use objc2::{msg_send, runtime::AnyObject};

        let ns_win = window.ns_window().map_err(|e| e.to_string())?;
        let win = ns_win.cast::<AnyObject>();
        if win.is_null() {
            return Err("Native window is unavailable".into());
        }
        unsafe {
            let sharing: usize = if stealth { 0 } else { 1 };
            let () = msg_send![win, setSharingType: sharing];
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, stealth);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn read_mini_capture_protection(window: &Window) -> Result<bool, String> {
    use core_foundation::{array::CFArray, number::CFNumber, string::CFString};
    use core_graphics::window::create_description_from_array;
    use objc2::{msg_send, runtime::AnyObject};

    let ns_win = window.ns_window().map_err(|e| e.to_string())?;
    let win = ns_win.cast::<AnyObject>();
    if win.is_null() {
        return Err("Native window is unavailable".into());
    }
    let number: isize = unsafe { msg_send![win, windowNumber] };
    if number > 0 {
        let descriptions = create_description_from_array(CFArray::from_copyable(&[number as u32]))
            .ok_or("Window server state is unavailable")?;
        if let Some(description) = descriptions.get(0) {
            let value = description
                .find(CFString::new("kCGWindowSharingState"))
                .ok_or("Window sharing state is unavailable")?;
            let sharing = value
                .downcast::<CFNumber>()
                .and_then(|n| n.to_i64())
                .ok_or("Invalid window sharing state")?;
            return Ok(sharing == 0);
        }
    }
    // A window that has never been shown has no WindowServer record yet.
    // Once it is visible, use the server state: AppKit readback can lag updates.
    let sharing: usize = unsafe { msg_send![win, sharingType] };
    Ok(sharing == 0)
}

/// Reapply protection through a fresh native host while keeping the same
/// WKWebView, microphone stream, recorder, transcription queue and React state.
#[cfg(target_os = "macos")]
pub fn renew_protected_mini(webview: &Webview) -> Result<Window, String> {
    let previous = webview.window();
    let size = previous.inner_size().map_err(|e| e.to_string())?;
    let position = previous.outer_position().map_err(|e| e.to_string())?;
    let scale = previous.scale_factor().map_err(|e| e.to_string())?;
    let size = size.to_logical::<f64>(scale);
    let position = position.to_logical::<f64>(scale);
    let visible = previous.is_visible().map_err(|e| e.to_string())?;
    static NEXT_HOST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!(
        "mini-host-{}",
        NEXT_HOST.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let next = tauri::window::WindowBuilder::new(webview.app_handle(), label)
        .title("Steppe Mini")
        .inner_size(size.width, size.height)
        .position(position.x, position.y)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .content_protected(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    if let Err(error) = configure_mini_window(&next) {
        let _ = next.close();
        return Err(error);
    }
    if let Err(error) = webview.reparent(&next) {
        let _ = webview.reparent(&previous);
        let _ = next.close();
        return Err(error.to_string());
    }
    let ready = (|| -> Result<(), String> {
        webview.set_auto_resize(true).map_err(|e| e.to_string())?;
        if visible {
            next.show().map_err(|e| e.to_string())?;
            next.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = ready {
        let _ = webview.reparent(&previous);
        let _ = next.close();
        return Err(error);
    }
    previous.hide().map_err(|e| e.to_string())?;
    previous.close().map_err(|e| e.to_string())?;
    Ok(next)
}
