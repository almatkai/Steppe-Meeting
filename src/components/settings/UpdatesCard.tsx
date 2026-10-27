import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowsClockwise, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { openRelease, updateTracker } from '../../store/updateStore';
import { relativeCheckTime, safeReleaseUrl, updateStatusText } from '../../utils/updateTracker';

const focus = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500';
const button = `inline-flex items-center justify-center gap-2 px-3 py-2 text-xs rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white disabled:opacity-50 ${focus}`;
export function UpdatesCard() {
  const state = useSyncExternalStore(updateTracker.subscribe, updateTracker.getSnapshot);
  const [now, setNow] = useState(Date.now());
  const [openError, setOpenError] = useState('');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const result = state.result;
  const error = state.error || (result?.status === 'error' ? result.error : '') || openError;
  const releaseUrl = result?.status === 'available' ? safeReleaseUrl(result.release_url) : null;
  return <section aria-labelledby="updates-title" className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-5">
    <div className="flex items-center gap-2.5">
      <div className="w-9 h-9 rounded-xl bg-neutral-800/70 border border-neutral-700 flex items-center justify-center text-neutral-300"><ArrowsClockwise className="w-5 h-5" /></div>
      <h3 id="updates-title" className="text-sm font-semibold text-white">Обновления</h3>
    </div>
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
      <p className="text-xs text-neutral-400 py-2">Текущая версия <span className="font-mono text-neutral-200 ml-2">{state.runtime?.current_version || 'Определяем…'}</span></p>
      <div className="sm:max-w-sm space-y-2">
        <div role="radiogroup" aria-label="Канал обновлений" className="grid grid-cols-2 p-1 rounded-xl bg-neutral-950 border border-neutral-800">
          {([['stable', 'Стабильный'], ['beta', 'Бета']] as const).map(([channel, label]) => <label key={channel} className={`relative min-h-9 flex items-center justify-center py-2 px-3 rounded-lg text-xs cursor-pointer has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-neutral-500 ${state.channel === channel ? 'bg-white text-neutral-950 font-semibold' : 'text-neutral-400 hover:text-white hover:bg-neutral-800/50'} ${!state.initialized ? 'opacity-50' : ''}`}>
            <input type="radio" name="update-channel" value={channel} className="sr-only" checked={state.channel === channel} disabled={!state.initialized} onChange={() => { setOpenError(''); updateTracker.changeChannel(channel); }} />{label}
          </label>)}
        </div>
        <p className="text-[11px] leading-relaxed text-neutral-400">Бета включает стабильные и предварительные сборки; они могут быть экспериментальными.</p>
        <div role="status" aria-live="polite" className="text-[11px] text-neutral-400 flex flex-wrap gap-2">
          {state.savingChannel ? 'Сохраняем канал…' : state.channelError ? `Не удалось сохранить канал: ${state.channelError}` : state.channelSaved ? 'Канал сохранён' : ''}
          {state.channelError && <button type="button" className={`underline rounded ${focus}`} onClick={() => updateTracker.retryChannel()}>Повторить</button>}
        </div>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-neutral-800">
      <div className="space-y-1 min-w-0">
        <div role="status" aria-live="polite" className={`flex items-center gap-2 text-xs ${result?.status === 'available' ? 'text-white' : 'text-neutral-300'}`}>
          {!!error && <WarningCircle className="w-4 h-4 shrink-0" />}
          <span>{state.checking ? 'Проверяем GitHub…' : updateStatusText(result, state.error || openError, now)}</span>
        </div>
        {result?.checked_at && <p className="text-[11px] text-neutral-400">Проверено: {relativeCheckTime(result.checked_at, now)}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {releaseUrl && <button type="button" className={button} onClick={() => { setOpenError(''); void openRelease(releaseUrl).catch(error => setOpenError(error instanceof Error ? error.message : String(error))); }}>Открыть релиз</button>}
        <button type="button" className={button} disabled={state.checking || state.savingChannel} onClick={() => { setOpenError(''); void updateTracker.check(true); }}>
          {state.checking && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}Проверить
        </button>
      </div>
    </div>
  </section>;
}
