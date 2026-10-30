// These describe the executable target, never the WebView's user agent.
// build-beta.py supplies them explicitly because it runs Vite before Tauri.
export const nativeBuildIdentity = {
  platform: import.meta.env?.TAURI_ENV_PLATFORM || '',
  arch: import.meta.env?.TAURI_ENV_ARCH || '',
};

export type UpdaterBlock = 'browser' | 'development' | 'mini' | 'missing_identity' | 'platform';
export function updateBlockReason(runtime: { native: boolean; production: boolean; mini: boolean; platform: string; arch: string }): UpdaterBlock | null {
  if (!runtime.native) return 'browser';
  if (!runtime.production) return 'development';
  if (runtime.mini) return 'mini';
  if (!runtime.platform || !runtime.arch) return 'missing_identity';
  return ['darwin', 'macos'].includes(runtime.platform) && ['aarch64', 'arm64'].includes(runtime.arch) ? null : 'platform';
}
