import { api } from '../services/api';
import { createSettingsAutosave } from '../utils/settingsAutosave';

export const settingsAutosave = createSettingsAutosave(api.saveConfig);
export function loadSettingsConfig() {
  return settingsAutosave.refresh(api.getConfig);
}
