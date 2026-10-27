import { getVersion } from '@tauri-apps/api/app';
import { api } from '../services/api';
import { isTauriEnvironment } from '../utils/tauriWindow';
import { createUpdateTracker, safeReleaseUrl } from '../utils/updateTracker';
import { version } from '../../package.json';

export const updateTracker = createUpdateTracker({
  async runtime() {
    const native = isTauriEnvironment();
    // Tauri injects the actual executable target through its build/dev hook.
    // Browser architecture stays unknown rather than guessing Apple Silicon
    // from a webview user-agent that reports Intel even on ARM machines.
    const platform = native ? import.meta.env.TAURI_ENV_PLATFORM || '' : /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'windows' : /Linux/.test(navigator.platform) ? 'linux' : '';
    return { current_version: native ? await getVersion() : version, platform, arch: native ? import.meta.env.TAURI_ENV_ARCH || '' : '' };
  },
  async loadChannel() { return (await api.getConfig()).update_channel === 'beta' ? 'beta' : 'stable'; },
  saveChannel: api.saveUpdateChannel,
  check: api.checkUpdates,
});

export async function openRelease(value?: string) {
  const url = safeReleaseUrl(value);
  if (!url) throw new Error('Некорректная ссылка на релиз GitHub');
  if (isTauriEnvironment()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
