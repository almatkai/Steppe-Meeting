import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { api, updateRequest } from './api';
import { frontendCaptureBusy } from '../utils/updateCapture';
import { isMiniWindow, isTauriEnvironment } from '../utils/tauriWindow';
import { createUpdatePort } from './updateAdapter';
import { nativeBuildIdentity } from '../utils/nativeBuildIdentity';

// All protocol mapping lives in the injected production adapter, also exercised in Node.
const enabled = () => isTauriEnvironment() && Boolean(import.meta.env?.PROD);
export const updaterSupported = () => enabled() && ['darwin','macos'].includes(nativeBuildIdentity.platform) && ['aarch64','arm64'].includes(nativeBuildIdentity.arch) && !isMiniWindow();
export const updatePort = createUpdatePort({
  enabled,
  supported: updaterSupported,
  captureBusy: frontendCaptureBusy, version:getVersion, request:updateRequest, check:api.checkUpdates,
  install: jobId => invoke('install_update',{jobId}), id: () => crypto.randomUUID(),
  storage: {getItem:key => localStorage.getItem(key), setItem:(key,value) => localStorage.setItem(key,value)},
});
