import type { SystemConfig } from '../types';

type Group = 'llm' | 'stt';
export type ConfigPatch = Partial<SystemConfig>;
export type SaveState = { status: 'idle' | 'pending' | 'saving' | 'saved' | 'error'; error: string; validation: string };
const groups: Group[] = ['llm', 'stt'];
const groupOf = (key: string): Group => key.startsWith('llm_') ? 'llm' : 'stt';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T,>(value: T): T => structuredClone(value);

export function mergeConfig(base: SystemConfig, patch: ConfigPatch): SystemConfig {
  const merged = { ...base, ...patch, llm_cli: { ...base.llm_cli } };
  for (const [provider, options] of Object.entries(patch.llm_cli || {})) {
    const id = provider as keyof SystemConfig['llm_cli'];
    merged.llm_cli[id] = { ...base.llm_cli[id], ...options };
  }
  return merged;
}

export function configDiff(base: SystemConfig, next: SystemConfig, group?: Group): ConfigPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof SystemConfig)[]) {
    // Update channels have their own endpoint; never send them with AI settings.
    if (key === 'update_channel' || (group && groupOf(key) !== group)) continue;
    if (key === 'llm_cli') {
      const providers: Record<string, unknown> = {};
      for (const [provider, options] of Object.entries(next.llm_cli)) {
        const old = base.llm_cli[provider as keyof SystemConfig['llm_cli']] || {};
        const changed = Object.fromEntries(Object.entries(options).filter(([k, v]) => !equal(old[k as keyof typeof old], v)));
        if (Object.keys(changed).length) providers[provider] = changed;
      }
      if (Object.keys(providers).length) patch.llm_cli = providers;
    } else if (!equal(base[key], next[key])) patch[key] = next[key];
  }
  return patch as ConfigPatch;
}

const httpUrl = (value: string) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; }
  catch { return false; }
};
export function settingsValidation(config: SystemConfig, group: Group): string {
  if (group === 'llm') {
    if (config.llm_mode === 'cli') {
      const options = config.llm_cli[config.llm_cli_provider] || {};
      if (options.path?.trim() && !options.path.trim().startsWith('/')) return 'Путь к CLI должен начинаться с /';
      if (config.llm_cli_provider === 'opencode' && !/^[^/\s]+\/[^\s#]+(#[^\s]+)?$/.test(options.model?.trim() || '')) return 'Укажите модель OpenCode в формате провайдер/модель';
    } else {
      if (!httpUrl(config.llm_base_url)) return 'Укажите полный HTTP или HTTPS URL провайдера';
      if (!config.llm_model.trim()) return 'Укажите модель для генерации';
    }
  } else if (config.whisper_mode === 'custom') {
    if (!httpUrl(config.whisper_base_url)) return 'Укажите полный HTTP или HTTPS URL Whisper';
    if (!config.whisper_model.trim()) return 'Укажите модель Whisper';
  }
  return '';
}

/** App-owned queue: leaving Settings never drops a draft or an in-flight write.
 * Serial writes acknowledge only their patch; newer edits remain in the draft.
 * Each group owns its debounce/error, so invalid LLM drafts cannot block STT.
 */
export function createSettingsAutosave(save: (patch: ConfigPatch) => Promise<unknown>, delay = 500) {
  let draft: SystemConfig | null = null, saved: SystemConfig | null = null;
  let writing: Group | null = null;
  let loading: Promise<void> | undefined;
  let revision = 0, saveRevision = 0;
  const listeners = new Set<() => void>();
  const timers: Partial<Record<Group, ReturnType<typeof setTimeout>>> = {};
  const ready = { llm: false, stt: false };
  const errors = { llm: '', stt: '' };
  // A failed response does not prove the server rejected the write. Retain
  // its exact field mask so retry reconciles even a draft reverted to baseline.
  const uncertain: Record<Group, ConfigPatch> = { llm: {}, stt: {} };
  const didSave = { llm: false, stt: false };
  let snapshot: { config: SystemConfig | null; llm: SaveState; stt: SaveState; saveRevision: number };
  const patchFor = (group: Group): ConfigPatch => {
    if (!saved || !draft) return {};
    const patch = configDiff(saved, draft, group);
    for (const key of Object.keys(uncertain[group]) as (keyof SystemConfig)[]) {
      if (key === 'llm_cli') {
        patch.llm_cli ??= {};
        for (const [name, options] of Object.entries(uncertain[group].llm_cli || {})) {
          const provider = name as keyof SystemConfig['llm_cli'];
          const latest = draft.llm_cli[provider] || {};
          patch.llm_cli[provider] = { ...patch.llm_cli[provider], ...Object.fromEntries(
            Object.keys(options || {}).map(field => [field, latest[field as keyof typeof latest] ?? '']),
          ) };
        }
      } else (patch as Record<string, unknown>)[key] = draft[key];
    }
    return patch;
  };
  const emit = () => {
    const state = (group: Group): SaveState => {
      const dirty = !!Object.keys(patchFor(group)).length;
      const validation = dirty && draft ? settingsValidation(draft, group) : '';
      return { status: errors[group] ? 'error' : writing === group ? 'saving' : dirty ? 'pending' : didSave[group] ? 'saved' : 'idle', error: errors[group], validation };
    };
    snapshot = { config: draft, llm: state('llm'), stt: state('stt'), saveRevision };
    listeners.forEach(listener => listener());
  };
  const pump = async () => {
    if (writing || !draft || !saved) return;
    const group = groups.find(g => ready[g] && !errors[g] && !settingsValidation(draft!, g) && Object.keys(patchFor(g)).length);
    if (!group) { emit(); return; }
    const patch = clone(patchFor(group));
    ready[group] = false;
    writing = group;
    emit();
    try {
      await save(patch);
      saved = mergeConfig(saved, patch);
      uncertain[group] = {};
      revision++;
      saveRevision++;
      didSave[group] = true;
    } catch (error) {
      uncertain[group] = patch;
      errors[group] = error instanceof Error ? error.message : String(error);
    } finally {
      writing = null;
      emit();
      void pump();
    }
  };
  const hydrate = (config: SystemConfig) => {
    // Reconcile a fresh shared config without overwriting locally pending fields.
    const pending = { ...patchFor('llm'), ...patchFor('stt') };
    saved = clone(config);
    draft = mergeConfig(clone(config), pending);
    for (const group of groups) {
      if (!Object.keys(patchFor(group)).length) errors[group] = '';
    }
    emit();
    void pump();
  };
  emit();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    get revision() { return revision; },
    hydrate,
    refresh(read: () => Promise<SystemConfig>) {
      if (loading) return loading;
      const startedAt = revision;
      loading = Promise.resolve().then(read).then(config => {
        // A late shared-config read cannot rewind a newer edit or acknowledgement.
        if (revision === startedAt) hydrate(config);
      }).finally(() => { loading = undefined; });
      return loading;
    },
    change(next: SystemConfig | ((previous: SystemConfig) => SystemConfig), debounce = false) {
      if (!draft) return; // Loading defaults is never a user edit.
      const value = typeof next === 'function' ? next(draft) : next;
      const changes = configDiff(draft, value);
      draft = clone(value);
      revision++;
      for (const group of groups) {
        if (!Object.keys(changes).some(key => groupOf(key) === group)) continue;
        clearTimeout(timers[group]);
        delete timers[group];
        errors[group] = '';
        ready[group] = !debounce;
        if (debounce) timers[group] = setTimeout(() => { delete timers[group]; ready[group] = true; void pump(); }, delay);
      }
      emit();
      void pump();
    },
    waitForSaved(group: Group): Promise<void> {
      // Discovery can await an autosave, but never triggers a hidden save itself.
      return new Promise((resolve, reject) => {
        const inspect = () => {
          const error = errors[group] || (draft ? settingsValidation(draft, group) : 'Настройки ещё не загружены');
          if (error) { listeners.delete(inspect); reject(new Error(error)); }
          else if (writing !== group && !Object.keys(patchFor(group)).length) { listeners.delete(inspect); resolve(); }
        };
        listeners.add(inspect);
        inspect();
      });
    },
    flush() {
      for (const group of groups) {
        clearTimeout(timers[group]); delete timers[group];
        if (!errors[group]) ready[group] = true;
      }
      void pump();
    },
    retry(group: Group) { errors[group] = ''; ready[group] = true; void pump(); },
  };
}
