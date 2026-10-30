import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleNotch, Play } from '@phosphor-icons/react';
import { api } from '../../services/api';
import type { GenerationAttempt, GenerationRoute } from '../../types';
import { createGenerationRetry, generationModelLabel, generationProviderKey } from '../../utils/generationRetry';

const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400';
const button = `min-h-8 px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-300 hover:text-white hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center justify-center gap-1.5 ${focus}`;
const input = `w-full min-h-8 py-2 px-3 rounded-lg bg-neutral-950 border border-neutral-700 text-white text-xs disabled:opacity-50 ${focus}`;
type Props = {
  meetingId: string; lastAttempt?: GenerationAttempt | null; busy: boolean;
  onStart(route: GenerationRoute): Promise<void>; onOpenChange(open: boolean): void; onSettings(): void;
};

/** Mount with key=meetingId; all async work belongs to this one panel session. */
export function GenerationRoutePanel({ meetingId, lastAttempt, busy, onStart, onOpenChange, onSettings }: Props) {
  const callbacks = useRef({ onStart, onOpenChange });
  callbacks.current = { onStart, onOpenChange };
  const [controller] = useState(() => createGenerationRetry({
    options: () => api.generationOptions(meetingId),
    models: option => api.generationModels(meetingId, option.mode, option.provider),
    start: route => callbacks.current.onStart(route),
  }, lastAttempt));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const toggleRef = useRef<HTMLButtonElement>(null), providerRef = useRef<HTMLSelectElement>(null), startRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    callbacks.current.onOpenChange(state.open);
    if (!state.open && wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = state.open;
  }, [state.open]);
  useEffect(() => { if (state.open && !state.loading && state.options) providerRef.current?.focus(); }, [state.open, state.loading]);
  useEffect(() => { if (state.startError && !state.starting && !busy) startRef.current?.focus(); }, [state.startError, state.starting, busy]);
  useEffect(() => () => { controller.close(); callbacks.current.onOpenChange(false); }, [controller]);

  const option = controller.selected(), draft = state.drafts[state.selected];
  const locked = busy || state.starting;
  const last = state.options?.last_attempt;
  const label = (route: GenerationRoute) => state.options?.providers.find(item => generationProviderKey(item) === generationProviderKey(route))?.label || route.provider;
  const routeLabel = (route: GenerationRoute) => `${label(route)} · ${generationModelLabel(route)}`;
  const defaultsDiffer = !!last && !!state.options && (generationProviderKey(last) !== generationProviderKey(state.options.default) || last.model !== state.options.default.model);
  const list = draft?.list;
  const groups = [...new Set((list?.models || []).map(model => model.provider || option?.provider || ''))];
  const manual = !list?.models.length || draft?.manual;
  const missingModel = !!draft?.model && !list?.models.some(model => model.id === draft.model);
  const required = !!option?.requires_model && !draft?.model.trim();
  const hint = required ? 'Укажите модель, чтобы запустить.' : option?.mode === 'api' ? 'Укажите модель API. Без модели запуск невозможен.' : option?.provider === 'opencode' ? 'Укажите модель явно: провайдер/модель, при необходимости #variant.' : 'Пусто — модель по умолчанию из настроек CLI.';
  const startLabel = option && draft ? `Запустить: ${option.label} · ${draft.model.trim() || (option.requires_model ? 'модель не указана' : 'модель по умолчанию')}` : 'Запустить';
  return <div className="space-y-3 text-xs">
    <button ref={toggleRef} type="button" className={button} disabled={locked} aria-expanded={state.open} aria-controls="gen-route-panel"
      onClick={() => { if (state.open) controller.close(); else void controller.open(); }}>
      <span aria-hidden="true">{state.open ? '▾' : '▸'}</span>Другой провайдер или модель
    </button>
    {state.open && <div id="gen-route-panel" className="space-y-3">
      {state.loading && <p role="status" aria-live="polite" className="text-neutral-400">Загружаем варианты…</p>}
      {state.error && <div role="status" aria-live="polite" className="text-neutral-300 flex flex-wrap items-center gap-2">
        <span>Не удалось загрузить варианты: {state.error}</span><button type="button" className={button} onClick={() => void controller.open()}>Повторить</button>
      </div>}
      {!state.loading && option && draft && <>
        {last && <div className="space-y-1 break-words">
          <p className="text-neutral-300">Последняя попытка: {routeLabel(last)}</p>
          {defaultsDiffer && <p className="text-[11px] text-neutral-400">Из настроек: {routeLabel(state.options!.default)}</p>}
        </div>}
        <div className="space-y-1.5">
          <label htmlFor="gen-route-provider" className="text-neutral-300">Провайдер</label>
          <select ref={providerRef} id="gen-route-provider" className={input} value={state.selected} disabled={locked} onChange={event => controller.select(event.target.value)}>
            {state.options!.providers.map(item => <option key={generationProviderKey(item)} value={generationProviderKey(item)}>{item.label}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="gen-route-model" className="text-neutral-300">Модель</label>
          {manual ? <input id="gen-route-model" className={`${input} font-mono`} value={draft.model} disabled={locked}
            placeholder={option.mode === 'api' ? 'Имя модели' : option.provider === 'opencode' ? 'провайдер/модель#variant' : 'Модель по умолчанию из настроек CLI'}
            aria-describedby="gen-route-model-hint" onChange={event => controller.model(event.target.value)} /> :
            <select id="gen-route-model" className={input} value={draft.model} disabled={locked} aria-describedby="gen-route-model-hint" onChange={event => controller.model(event.target.value)}>
              <option value="">{option.requires_model ? 'Выберите модель' : 'Модель по умолчанию из настроек CLI'}</option>
              {missingModel && <option value={draft.model}>{draft.model} (нет в загруженном списке)</option>}
              {groups.map(group => <optgroup key={group} label={group === 'api' ? option.label : group}>{list!.models.filter(model => (model.provider || option.provider) === group).map(model => <option key={model.id} value={model.id}>{model.name || model.id}{model.free === true ? ' · бесплатно' : ''}</option>)}</optgroup>)}
            </select>}
          <p id="gen-route-model-hint" className="text-[11px] text-neutral-400">{hint}</p>
          <div className="flex flex-wrap gap-2">
            {option.supports_models && <button type="button" className={button} disabled={locked || draft.loading} aria-busy={draft.loading} onClick={() => void controller.loadModels()}>
              {draft.loading && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}{draft.loading ? 'Загружаем модели…' : 'Загрузить модели'}
            </button>}
            {!!list?.models.length && <button type="button" className={button} disabled={locked} onClick={controller.manual}>{manual ? 'Из списка' : 'Ввести вручную'}</button>}
          </div>
          <div role="status" aria-live="polite" className="text-[11px] text-neutral-400">
            {draft.listError ? <p>{draft.listError}</p> : list && <p>Получено моделей: {list.models.length} · Список получен в {new Date(list.fetched_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</p>}
          </div>
        </div>
        <p className="text-[11px] text-neutral-400">Только для этой попытки. Настройки AI не изменятся. Текст встречи получит выбранный провайдер — так же, как при обычной работе через CLI или API.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button ref={startRef} type="button" className={`${button} bg-white !text-neutral-950 hover:!bg-neutral-200 min-w-0 max-w-full`} disabled={locked || required} aria-busy={state.starting} aria-describedby="gen-route-model-hint" title={startLabel} aria-label={startLabel}
            onClick={() => void controller.start()}>
            {state.starting ? <CircleNotch className="w-3.5 h-3.5 shrink-0 animate-spin" /> : <Play className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate">{state.starting ? 'Запускаем…' : startLabel}</span>
          </button>
          <button type="button" className={button} disabled={locked} onClick={controller.close}>Отмена</button>
          <button type="button" className={`min-h-8 underline text-neutral-400 hover:text-white rounded ${focus}`} disabled={locked} onClick={onSettings}>Настроить другой API →</button>
        </div>
        {state.startError && <p role="alert" className="text-rose-300">Не удалось запустить: {state.startError}</p>}
      </>}
    </div>}
  </div>;
}
