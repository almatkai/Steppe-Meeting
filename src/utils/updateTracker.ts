import type { ReleaseUpdate, UpdateChannel } from '../types';

export type UpdateRuntime = { current_version: string; platform: string; arch: string };
type Dependencies = {
  runtime: () => Promise<UpdateRuntime>;
  loadChannel: () => Promise<UpdateChannel>;
  saveChannel: (channel: UpdateChannel) => Promise<unknown>;
  check: (query: UpdateRuntime & { channel: UpdateChannel; force: boolean }) => Promise<ReleaseUpdate>;
};
export type UpdateSnapshot = {
  channel: UpdateChannel; runtime: UpdateRuntime | null; initialized: boolean;
  checking: boolean; savingChannel: boolean; channelSaved: boolean; channelError: string;
  result: ReleaseUpdate | null; error: string;
};

export function createUpdateTracker(deps: Dependencies) {
  let state: UpdateSnapshot = { channel: 'stable', runtime: null, initialized: false, checking: false, savingChannel: false, channelSaved: false, channelError: '', result: null, error: '' };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateSnapshot>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  let initialization: Promise<void> | undefined;
  let persisted: UpdateChannel | null = 'stable';
  let channelWrite: Promise<void> | undefined;
  let epoch = 0;
  let inflight: { epoch: number; promise: Promise<void> } | undefined;
  const initialize = () => {
    if (state.initialized) return Promise.resolve();
    return initialization ??= Promise.all([deps.runtime(), deps.loadChannel()]).then(([runtime, channel]) => {
      if (!runtime.current_version) throw new Error('Не удалось определить версию приложения');
      persisted = channel;
      set({ runtime, channel, initialized: true, error: '' });
    }).finally(() => { initialization = undefined; });
  };
  const check = async (force = false): Promise<void> => {
    if (!state.initialized) set({ checking: true, error: '' });
    try { await initialize(); }
    catch (error) { set({ error: String(error instanceof Error ? error.message : error), checking: false }); return; }
    if (channelWrite) await channelWrite;
    if (state.channelError) return;
    const requestEpoch = epoch;
    if (inflight?.epoch === requestEpoch) return inflight.promise;
    set({ checking: true, error: '' });
    const query = { ...state.runtime!, channel: state.channel, force };
    const promise = (async () => {
      try {
        const result = await Promise.resolve().then(() => deps.check(query));
        if (epoch === requestEpoch) {
          if (result.channel !== state.channel || result.current_version !== state.runtime?.current_version) throw new Error('GitHub вернул ответ для другой версии или канала');
          set({ result, error: '' });
        }
      } catch (error) {
        if (epoch === requestEpoch) set({ result: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (epoch === requestEpoch) set({ checking: false });
        if (inflight?.epoch === requestEpoch) inflight = undefined;
      }
    })();
    inflight = { epoch: requestEpoch, promise };
    return promise;
  };
  const persistChannel = () => {
    if (channelWrite) return channelWrite;
    channelWrite = (async () => {
      while (persisted !== state.channel) {
        const channel = state.channel;
        try {
          await deps.saveChannel(channel);
          persisted = channel;
        } catch (error) {
          // The write may have committed before its response was lost.
          persisted = null;
          if (channel !== state.channel) continue;
          set({ channelError: error instanceof Error ? error.message : String(error), savingChannel: false });
          return;
        }
      }
      set({ savingChannel: false, channelSaved: true, channelError: '' });
    })().finally(() => { channelWrite = undefined; });
    return channelWrite;
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    check,
    changeChannel(channel: UpdateChannel) {
      if (!state.initialized || (state.channel === channel && !state.channelError)) return;
      epoch++;
      set({ channel, result: null, error: '', checking: false, savingChannel: true, channelSaved: false, channelError: '' });
      void persistChannel().then(() => { if (!state.channelError) void check(); });
    },
    retryChannel() {
      set({ savingChannel: true, channelError: '' });
      void persistChannel().then(() => { if (!state.channelError) void check(); });
    },
  };
}

export function safeReleaseUrl(value?: string): string | null {
  if (!value || /[\s\\\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null;
    if (!/^\/almatkai\/Steppe-Meeting\/releases(?:\/tag\/[^/]+)?\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function updateStatusText(result: ReleaseUpdate | null, error = '', now = Date.now()): string {
  if (!error && !result) return 'Проверка ещё не выполнена';
  if (!error && result?.status === 'no_releases') return 'Релизов на GitHub пока нет';
  if (!error && result?.status === 'up_to_date') return 'Установлена последняя версия';
  if (!error && result?.status === 'available') {
    const date = result.published_at ? new Date(result.published_at) : null;
    return `Доступна ${result.latest_version || result.tag_name || 'новая версия'}${date && Number.isFinite(date.getTime()) ? ` · ${date.toLocaleDateString('ru')}` : ''}`;
  }
  const message = error || result?.error || 'Не удалось проверить обновления';
  if (/лимит|ограничил|rate.?limit|too many/i.test(message)) {
    if (!result?.retry_at && result?.retry_after === undefined) return 'Лимит GitHub API. Повторите попытку позже.';
    const retry = result?.retry_at ? new Date(result.retry_at) : typeof result?.retry_after === 'number' ? new Date(Date.parse(result.checked_at) + result.retry_after * 1000) : new Date(result?.retry_after || now);
    return `Лимит GitHub API, повторите после ${Number.isFinite(retry.getTime()) ? retry.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : 'паузы'}`;
  }
  if (/подключени|связаться|интернет|offline|network/i.test(message)) return 'Нет подключения к GitHub';
  return message;
}

export function relativeCheckTime(stamp: string, now = Date.now()): string {
  const elapsed = now - Date.parse(stamp);
  if (!Number.isFinite(elapsed)) return 'время неизвестно';
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes === 0) return 'только что';
  const fmt = new Intl.RelativeTimeFormat('ru', { numeric: 'always' });
  return minutes < 60 ? fmt.format(-minutes, 'minute') : minutes < 1440 ? fmt.format(-Math.floor(minutes / 60), 'hour') : fmt.format(-Math.floor(minutes / 1440), 'day');
}
