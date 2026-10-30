// These describe the executable target, never the WebView's user agent.
// build-beta.py supplies them explicitly because it runs Vite before Tauri.
export const nativeBuildIdentity = {
  platform: import.meta.env?.TAURI_ENV_PLATFORM || '',
  arch: import.meta.env?.TAURI_ENV_ARCH || '',
};
