import { getVersion } from '@tauri-apps/api/app';
import { api } from '../services/api';
import { isTauriEnvironment } from '../utils/tauriWindow';
import { createUpdateTracker, safeReleaseUrl } from '../utils/updateTracker';
import { version } from '../../package.json';
import { nativeBuildIdentity } from '../utils/nativeBuildIdentity';

export const updateTracker = createUpdateTracker({
  async runtime() {
    const native = isTauriEnvironment();
    // The packaging pipeline or Tauri build/dev hook supplies the executable target.
    // Browser architecture stays unknown rather than guessing Apple Silicon
    // from a webview user-agent that reports Intel even on ARM machines.
    const platform = native ? nativeBuildIdentity.platform : /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'windows' : /Linux/.test(navigator.platform) ? 'linux' : '';
    return { current_version: native ? await getVersion() : version, platform, arch: native ? nativeBuildIdentity.arch : '' };
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

// App-owned: Settings unmounts never stop polling or discard the job.
import { createUpdateController, updateActive } from '../utils/updateController';
import { updatePort, updaterSupported } from '../services/updatePort';
import { createUpdatePolling } from '../utils/updatePolling';
import { connectCaptureActivity } from '../utils/updateCapture';
import { setUpdateInstalling } from '../services/api';
// One Web Locks owner observes the backend; sibling windows receive observations.
let observationChannel: BroadcastChannel | undefined;
let cachedObservation: Awaited<ReturnType<typeof updatePort.observe>> | undefined;
let ownsObservation = false;
const controller = createUpdateController({ ...updatePort, async observe() {
  if (observationChannel && !ownsObservation) {
    if (cachedObservation) return { ...cachedObservation, supported: updaterSupported() };
    throw { code: 'unavailable' };
  }
  const value = await updatePort.observe();
  observationChannel?.postMessage(value);
  return value;
} });
const wakeObserver = () => {
  if (ownsObservation || !observationChannel) stopPolling?.wake();
  else observationChannel.postMessage({ refresh: true });
};
export const updateController = { ...controller,
  async begin(...args: Parameters<typeof controller.begin>) { try { await controller.begin(...args); } finally { wakeObserver(); } },
  async install() { try { await controller.install(); } finally { wakeObserver(); } },
  async cancel() { try { await controller.cancel(); } finally { wakeObserver(); } },
};
updateController.subscribe(() => {
  const state = updateController.getSnapshot();
  setUpdateInstalling(state.stage === 'installing');
  updateTracker.setJobActive(updateActive(state));
});
let stopPolling: ReturnType<typeof createUpdatePolling> | undefined;
let releaseObserver: (() => void) | undefined;
let updateUsers = 0;
let stopActivity: (() => void) | undefined;
export function mountUpdater() {
  if (++updateUsers === 1) {
    const activity = () => updateController.activity(['recording']);
    window.addEventListener('steppe-update-activity', activity);
    const disconnect = connectCaptureActivity(activity);
    stopActivity = () => { window.removeEventListener('steppe-update-activity', activity); disconnect(); };
    const poll = () => createUpdatePolling(updateController.refresh, () => updateActive(updateController.getSnapshot()), {
      set: (fn, delay) => setTimeout(fn, delay), clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    if (typeof BroadcastChannel !== 'undefined' && navigator.locks) {
      observationChannel = new BroadcastChannel('steppe-update-observation');
      observationChannel.onmessage = event => {
        if (event.data?.refresh) { if (ownsObservation) stopPolling?.wake(); return; }
        cachedObservation = event.data; void updateController.refresh();
      };
      const abort = new AbortController();
      let unlock: (() => void) | undefined;
      void navigator.locks.request('steppe-update-observer', { signal: abort.signal }, async () => {
        ownsObservation = true;
        stopPolling = poll();
        await new Promise<void>(resolve => { unlock = resolve; });
        stopPolling?.(); ownsObservation = false;
      }).catch(() => {});
      releaseObserver = () => { abort.abort(); unlock?.(); observationChannel?.close(); observationChannel = undefined; cachedObservation = undefined; };
    } else stopPolling = poll();
  }
  return () => { if (--updateUsers === 0) { stopPolling?.(); stopPolling = undefined; releaseObserver?.(); releaseObserver = undefined; stopActivity?.(); stopActivity = undefined; } };
}
