import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from './tauriWindow';

export function createCaptureFence(port: { acquire(): Promise<void>; release(): Promise<void>; announce(): void }) {
  let count = 0, tail = Promise.resolve();
  const serialize = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  };
  return async () => {
    port.announce();
    await serialize(async () => { if (!count) await port.acquire(); count++; });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await serialize(async () => { if (--count === 0) await port.release(); });
    };
  };
}
const windowId = Math.random().toString(36).slice(2);
const windows = new Set<string>();
let activityChannel: BroadcastChannel | null = null;
export const frontendCaptureBusy = () => windows.size > 0;
export function connectCaptureActivity(onActivity: () => void) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = activityChannel = new BroadcastChannel('steppe-update-activity');
  channel.onmessage = event => {
    if (event.data?.query) { channel.postMessage({ windowId, busy: windows.has(windowId) }); return; }
    const value = event.data;
    if (typeof value?.windowId !== 'string') return;
    if (value.busy) { windows.add(value.windowId); onActivity(); } else windows.delete(value.windowId);
  };
  channel.postMessage({ query: true });
  return () => { channel.close(); if (activityChannel === channel) activityChannel = null; };
}
function publish(busy: boolean) {
  if (busy) windows.add(windowId); else windows.delete(windowId);
  activityChannel?.postMessage({ windowId, busy });
}
/** Native window fence is acquired before media; release after pending audio settles. */
export const acquireUpdateCapture = createCaptureFence({
  async acquire() {
    publish(true);
    try { if (isTauriEnvironment()) await invoke('set_update_capture_busy', { busy: true }); }
    catch (error) { publish(false); throw error; }
  },
  async release() {
    if (isTauriEnvironment()) await invoke('set_update_capture_busy', { busy: false });
    publish(false);
  },
  announce() { window.dispatchEvent(new Event('steppe-update-activity')); },
});
