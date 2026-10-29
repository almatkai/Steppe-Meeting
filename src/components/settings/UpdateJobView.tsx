import { useLayoutEffect, useRef } from 'react';
import type { UpdateState } from '../../utils/updateController';
import { busyText, updateActive, updateDownloadUrl } from '../../utils/updateController';

const focus = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500';
export const updateButton = `inline-flex min-h-8 items-center justify-center gap-2 px-3 py-1 text-xs rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white disabled:opacity-50 ${focus}`;
export const updatePrimary = `${updateButton} bg-white !text-neutral-950 hover:!bg-neutral-200`;
const errors = {
  cancel_failed: 'Не удалось отменить загрузку. Проверьте её состояние или повторите отмену',
  network: 'Не удалось загрузить обновление', checksum: 'Файл обновления не прошёл проверку',
  disk_full: 'Недостаточно места на диске', not_writable: 'Нет прав для установки обновления',
  busy: 'Установить можно после завершения текущей работы', install_failed: 'Не удалось установить обновление. Проверьте состояние приложения',
  unavailable: 'Не удалось уточнить состояние обновления. Проверьте ещё раз',
  download_failed: 'Не удалось загрузить и проверить обновление',
  stale_selection: 'Релиз изменился или выбор устарел. Проверьте обновления ещё раз',
  verification_unavailable: 'Для этого релиза недоступна проверенная установка',
  journal_invalid: 'Не удалось проверить состояние установки. Требуется проверка приложения',
  recovery_required: 'Требуется восстановление приложения. Восстановите предыдущую версию или скачайте установщик',
  unsupported: 'Автоматическая установка доступна в поддерживаемой сборке приложения', interrupted: 'Загрузка прервана',
};
export function UpdateJobView({ state, availableVersion, status, checked, releaseUrl, checkDisabled, onBegin, onInstall, onCancel, onCheck, onManual, onRecover }: {
  state: UpdateState; availableVersion?: string; status: string; checked?: string; releaseUrl: string | null; checkDisabled: boolean;
  onBegin: () => void; onInstall: () => void; onCancel: () => void; onCheck: () => void; onManual: () => void;
  onRecover?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null), statusRef = useRef<HTMLDivElement>(null), cancelRef = useRef<HTMLButtonElement>(null);
  const ownsFocus = useRef(false);
  useLayoutEffect(() => {
    if (ownsFocus.current && (!document.activeElement || document.activeElement === document.body || (document.activeElement as HTMLButtonElement).disabled)) {
      (cancelRef.current || statusRef.current)?.focus();
    }
  }, [state.stage]);
  const active = updateActive(state), failed = state.stage === 'failed';
  const unsupported = state.initialized && !state.supported;
  const recovering = state.receipt?.outcome === 'recovery_required';
  const manual = !!updateDownloadUrl(state, releaseUrl) && (recovering || unsupported || ['checksum', 'install_failed', 'not_writable', 'unsupported', 'verification_unavailable', 'journal_invalid', 'recovery_required'].includes(state.error || ''));
  const version = active ? state.target?.latest_version : availableVersion || state.target?.latest_version;
  const bytes = Math.max(0, state.job?.bytes || 0), total = state.job?.total;
  const percent = total && total > 0 ? Math.min(100, Math.floor(bytes / total * 100)) : undefined;
  const progress = `${(bytes / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 1 })}${total ? ` из ${(total / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 1 })}` : ''} МБ${percent !== undefined ? ` · ${percent} %` : ''}`;
  const stageText = state.stage === 'starting' ? 'Начинаем загрузку…' : state.stage === 'downloading' ? 'Загрузка обновления…' : state.stage === 'verifying' ? 'Проверяем файл обновления…' : state.stage === 'ready' ? 'Обновление загружено' : state.stage === 'installing' ? 'Устанавливаем обновление. Приложение перезапустится' : state.stage === 'cancelling' ? 'Отменяем загрузку…' : state.stage === 'completed' ? `Обновлено до ${state.receipt?.version}` : failed ? errors[state.error || 'install_failed'] : status;
  const helper = state.stage === 'installing' ? 'Не закрывайте приложение' : state.error && !failed ? errors[state.error] : state.stage === 'ready' ? busyText(state.busy) || (state.error === 'busy' ? errors.busy : 'Для установки нажмите «Установить и перезапустить»') : failed && state.error === 'network' ? 'Проверьте подключение к интернету' : state.stage === 'completed' ? 'macOS может заново запросить доступ к микрофону и записи экрана' : unsupported && availableVersion ? errors[state.unavailable === 'not_writable' ? 'not_writable' : 'unsupported'] : checked;
  return <div ref={root} onFocusCapture={() => { ownsFocus.current = true; }} onBlurCapture={event => {
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) ownsFocus.current = false;

  }} className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-neutral-800">
    <div className="space-y-1 min-w-0 flex-1">
      <div ref={statusRef} tabIndex={-1} className={`text-xs text-neutral-200 rounded ${focus}`}>{stageText}</div>
      <div id="update-helper" className="min-h-12 text-[11px] text-neutral-400">
        {state.stage === 'downloading' ? <>
          <div role="progressbar" aria-label="Загрузка обновления" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={progress} className="h-0.5 bg-neutral-800 my-2 overflow-hidden"><div className={`h-full bg-neutral-200 ${percent === undefined ? 'w-1/3 animate-pulse' : ''}`} style={percent === undefined ? undefined : { width: `${percent}%` }} /></div>
          <span className="font-mono">{progress}</span>
        </> : helper}
        {state.stage === 'downloading' && state.error && <div>{errors[state.error]}</div>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{!state.error && <>{stageText}{state.stage === 'downloading' && percent !== undefined ? ` ${Math.floor(percent / 25) * 25} %` : ''}{state.stage === 'ready' ? ` ${busyText(state.busy)}` : ''}</>}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{state.error ? errors[state.error] : ''}</div>
    </div>
    <div className="flex flex-wrap gap-2">
      {state.stage === 'ready' && <button type="button" className={updatePrimary} disabled={state.busy.length > 0} aria-describedby="update-helper" onClick={onInstall}>Установить и перезапустить</button>}
      {active && state.stage !== 'installing' && state.job?.cancellable !== false && <button ref={cancelRef} type="button" className={updateButton} disabled={state.stage === 'cancelling'} onClick={onCancel}>Отменить</button>}
      {!active && <>
        {state.receipt?.outcome === 'recovery_required' && onRecover && <button type="button" className={updatePrimary} disabled={state.busy.length > 0 || !state.supported} aria-describedby="update-helper" onClick={onRecover}>Восстановить предыдущую версию</button>}
        {version && !recovering && !unsupported && state.initialized && state.supported && state.stage !== 'completed' && !['recovery_required','journal_invalid','stale_selection','verification_unavailable','unavailable'].includes(state.error || '') && <button type="button" className={updatePrimary} disabled={checkDisabled} onClick={onBegin}>{failed ? 'Повторить' : `Обновить до ${version}`}</button>}
        {manual && <button type="button" className={unsupported ? updatePrimary : updateButton} onClick={onManual}>Скачать вручную</button>}
        <button type="button" className={updateButton} disabled={checkDisabled} onClick={onCheck}>Проверить</button>
      </>}
    </div>
  </div>;
}
