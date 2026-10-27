import { useRef, useState } from 'react';
import { ArrowsClockwise, CircleNotch, Info } from '@phosphor-icons/react';
import { api } from '../../services/api';
import type { CliCheckResult, CliModelAccess, CliModelsResult, CliProviderId, SystemConfig } from '../../types';
import { cliExecutableLabel, cliKey, cliModelVisibility, cliReadiness, cliValidation } from '../../utils/cliSettings';

export const CLI_PROVIDERS: Array<{ id: CliProviderId; name: string; binary: string }> = [
  { id: 'opencode', name: 'OpenCode', binary: 'opencode' },
  { id: 'codex', name: 'Codex CLI', binary: 'codex' },
  { id: 'claude', name: 'Claude Code', binary: 'claude' },
  { id: 'antigravity', name: 'Antigravity', binary: 'agy' },
];
const time = (stamp: string) => new Date(stamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const input = 'w-full min-h-8 py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white text-xs';
const button = 'min-h-8 px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-300 hover:text-white hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';

type Props = {
  config: SystemConfig;
  onChange: (config: SystemConfig, debounce?: boolean) => void;
  checks: Record<string, CliCheckResult>;
  onCheck: (key: string, check: CliCheckResult) => void;
  onAccess: (key: string, access: CliModelAccess) => void;
};
export function CliSettings({ config, onChange, checks, onCheck, onAccess }: Props) {
  const provider = config.llm_cli_provider;
  const options = config.llm_cli[provider] || {};
  const key = cliKey(config);
  const check = checks[key];
  const [manualPath, setManualPath] = useState(false);
  const [manualModels, setManualModels] = useState<Partial<Record<CliProviderId, boolean>>>({});
  const [touchedModels, setTouchedModels] = useState<Record<string, boolean>>({});
  const [lists, setLists] = useState<Record<string, CliModelsResult>>({});
  const [freeOnly, setFreeOnly] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, { tested_at: string; text: string }>>({});
  const identity = JSON.stringify([key, options.model?.trim() || '']);
  const current = useRef(identity);
  current.current = identity;
  const list = lists[key];
  const oldList = Object.entries(lists).find(([k, value]) => k !== key && value.provider === provider)?.[1];
  const stale = !list && !!oldList;
  const validation = cliValidation(config);
  const pathError = options.path?.trim() && !options.path.trim().startsWith('/') ? 'Путь должен начинаться с /' : '';
  const modelError = pathError || !touchedModels[key] ? '' : validation;
  // Some CLIs cannot report login status; a model response confirms access.
  // A failed probe or a known missing login still blocks the test.
  const ready = check?.available && !check.error && check.auth !== 'required';
  const status = cliReadiness(check, options.model);
  const canList = provider === 'opencode' || check?.supports_models;
  const manual = manualModels[provider] ?? !list?.models.length;
  const update = (field: 'path' | 'model', value: string, debounce = false) => {
    if (field === 'model') setTouchedModels(prev => ({ ...prev, [key]: true }));
    onChange({ ...config, llm_cli: { ...config.llm_cli, [provider]: { ...options, [field]: value } } }, debounce);
  };
  const act = async (action: 'check' | 'models' | 'test') => {
    const requestKey = key, requestIdentity = identity;
    setBusy(prev => ({ ...prev, [requestKey]: action }));
    try {
      if (action === 'check') onCheck(requestKey, await api.checkCli(provider, options.path?.trim()));
      else if (action === 'models') {
        const result = await api.cliModels(provider, options.path?.trim());
        setLists(prev => ({ ...prev, [requestKey]: result }));
        if (current.current === requestIdentity && result.models.length) setManualModels(prev => ({ ...prev, [provider]: false }));
      } else {
        const result = await api.testCli(provider, options.path?.trim(), options.model?.trim());
        const access = result.access || { model: options.model?.trim() || '', path: check?.path || '',
          ok: result.ok, tested_at: new Date().toISOString(), elapsed_ms: result.elapsed_ms, error: result.error };
        onAccess(requestKey, access);
        // Keep only the tiny test's preview in this view. Runtime readiness
        // stores metadata, never generated meeting content or full responses.
        setPreviews(previous => ({ ...previous, [requestIdentity]: {
          tested_at: access.tested_at, text: result.ok ? result.response?.slice(0, 80) || '' : '',
        } }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (action === 'check') onCheck(requestKey, { provider, configured_path: options.path?.trim() || '', path: check?.path,
        available: false, auth: 'unknown', supports_models: !!check?.supports_models, checked_at: new Date().toISOString(), error: message });
      else if (action === 'test') onAccess(requestKey, { model: options.model?.trim() || '', path: check?.path || '',
        ok: false, tested_at: new Date().toISOString(), elapsed_ms: 0, error: message });
      else setLists(prev => ({ ...prev, [requestKey]: { provider, models: [], pricing_available: false,
        fetched_at: new Date().toISOString(), error: message } }));
    } finally { setBusy(prev => ({ ...prev, [requestKey]: '' })); }
  };
  const visibleModels = (list?.models || []).filter(model => !freeOnly || !list?.pricing_available || model.free === true);
  const groupNames = [...new Set(visibleModels.map(model => model.provider || provider))];
  const savedModelVisibility = options.model ? cliModelVisibility(options.model, list?.models || [], visibleModels) : 'visible';
  const test = status.access;
  const preview = previews[identity]?.tested_at === test?.tested_at ? previews[identity]?.text : '';
  const error = check?.error || (test && !test.ok ? test.error : '');
  return <div className="cli-settings space-y-4 text-xs">
    <div role="radiogroup" aria-label="CLI провайдер" className="space-y-1.5">
      {CLI_PROVIDERS.map(item => {
        const rowCheck = checks[JSON.stringify([item.id, config.llm_cli[item.id]?.path?.trim() || ''])];
        const row = cliReadiness(rowCheck, config.llm_cli[item.id]?.model);
        const rowStatus = row.label;
        return <label key={item.id} className={`min-h-9 min-w-0 flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer ${provider === item.id ? 'bg-neutral-800 border-neutral-600 font-semibold text-white' : 'border-neutral-800 text-neutral-300'}`}>
          <input type="radio" name="llm-cli-provider" value={item.id} checked={provider === item.id}
            onChange={() => { onChange({ ...config, llm_cli_provider: item.id }); setFreeOnly(false); }} />
          <span className="shrink-0">{item.name}</span><span title={rowStatus} className={`ml-auto min-w-0 truncate text-[11px] font-normal ${row.tone === 'error' ? 'text-rose-400' : row.tone === 'warning' ? 'text-amber-400' : row.tone === 'success' ? 'text-emerald-400' : 'text-neutral-400'}`}>{rowStatus}</span>
        </label>;
      })}
    </div>
    <p className="flex gap-2 text-[11px] leading-relaxed text-neutral-400"><Info className="w-4 h-4 shrink-0 mt-0.5" />
      <span>CLI запускается на этом компьютере, но модель может работать в облаке провайдера: текст встречи уходит туда же, куда и при обычной работе CLI. Полностью офлайн генерация возможна только с локальной моделью, например через Ollama: в режиме API или как провайдер внутри OpenCode.</span>
    </p>
    <div className="space-y-1.5">
      <p className="font-medium text-neutral-300">Исполняемый файл</p>
      <p className="font-mono text-[11px] break-all text-neutral-400">{cliExecutableLabel(check)}</p>
      <button type="button" className={`${button} text-[11px]`} aria-expanded={options.path ? undefined : manualPath}
        onClick={() => { if (options.path) { update('path', ''); setManualPath(false); } else setManualPath(!manualPath); }}>
        {options.path ? 'Использовать автопоиск' : manualPath ? 'Скрыть ручной путь' : 'Указать путь вручную'}
      </button>
      {(manualPath || options.path) && <div className="space-y-1.5">
        <label htmlFor="cli-path" className="text-neutral-300">Полный путь к CLI</label>
        <input id="cli-path" value={options.path || ''} onChange={event => update('path', event.target.value, true)} placeholder="/opt/homebrew/bin/codex"
          className={`${input} font-mono`} aria-invalid={!!pathError} aria-describedby="cli-path-hint cli-path-error" />
      </div>}
      <p id="cli-path-hint" className="text-[11px] text-neutral-500">Пустой путь — найти автоматически. Нужен исполняемый файл, а не команда shell.</p>
      <p id="cli-path-error" role={pathError ? 'alert' : undefined} className="text-rose-400">{pathError}</p>
    </div>
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="cli-model" className="font-medium text-neutral-300 mr-auto">Модель</label>
        {canList && <button type="button" className={button} disabled={!!busy[key] || !!pathError} aria-busy={busy[key] === 'models'} onClick={() => void act('models')}>
          {busy[key] === 'models' ? <CircleNotch className="animate-spin w-3.5 h-3.5" /> : <ArrowsClockwise className="w-3.5 h-3.5" />}
          {busy[key] === 'models' ? 'Загружаем модели…' : 'Загрузить модели'}
        </button>}
        {!!list?.models.length && <button type="button" className={button} onClick={() => setManualModels(prev => ({ ...prev, [provider]: !manual }))}>{manual ? 'Из списка' : 'Ввести вручную'}</button>}
      </div>
      {stale && <p className="text-[11px] text-neutral-400">Список мог устареть — обновите</p>}
      {manual ? <input id="cli-model" value={options.model || ''} onChange={event => update('model', event.target.value, true)}
        className={`${input} font-mono`} placeholder={provider === 'opencode' ? 'провайдер/модель#variant' : 'Модель по умолчанию из настроек CLI'}
        onBlur={() => setTouchedModels(prev => ({ ...prev, [key]: true }))} aria-invalid={!!modelError} aria-describedby="cli-model-hint cli-model-error" /> :
        <select id="cli-model" className={input} value={options.model || ''} onChange={event => update('model', event.target.value)} onBlur={() => setTouchedModels(prev => ({ ...prev, [key]: true }))} aria-describedby="cli-model-hint cli-model-error" aria-invalid={!!modelError}>
          <option value="">{provider === 'opencode' ? 'Выберите модель' : 'Модель по умолчанию из настроек CLI'}</option>
          {savedModelVisibility === 'missing' && <option value={options.model}>{options.model} (текущая, нет в последнем списке)</option>}
          {savedModelVisibility === 'filtered' && <option value={options.model}>{options.model} (скрыта фильтром «бесплатные»)</option>}
          {groupNames.map(group => <optgroup key={group} label={group}>{visibleModels.filter(model => (model.provider || provider) === group).map(model => <option key={model.id} value={model.id}>{model.name || model.id}{model.free === true ? ' · бесплатно' : ''}</option>)}</optgroup>)}
        </select>}
      <p id="cli-model-error" role={modelError ? 'alert' : undefined} className="text-rose-400">{modelError}</p>
      <p id="cli-model-hint" className="text-[11px] text-neutral-500">{provider === 'opencode' ? 'Укажите модель явно: провайдер/модель, при необходимости #variant. Автоматического выбора модели нет.' : 'Пустое значение использует модель по умолчанию из настроек CLI.'}</p>
      {provider === 'opencode' && <div className="space-y-1">
        <label className="min-h-7 flex items-center gap-2 text-neutral-300"><input type="checkbox" checked={freeOnly && !!list?.pricing_available} disabled={!list?.pricing_available} onChange={event => setFreeOnly(event.target.checked)} />Только бесплатные</label>
        {!list?.pricing_available && <p className="text-[11px] text-neutral-500">OpenCode не сообщает стоимость моделей — бесплатность определить нельзя</p>}
      </div>}
      {list && <p className="text-[11px] text-neutral-500">{list.error ? 'Попытка загрузки в' : 'Список получен в'} {time(list.fetched_at)}</p>}
    </div>
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!!busy[key] || !!pathError} aria-busy={busy[key] === 'check'} onClick={() => void act('check')}>
          {busy[key] === 'check' && <CircleNotch className="animate-spin w-3.5 h-3.5" />}{busy[key] === 'check' ? 'Проверяем…' : 'Проверить CLI'}
        </button>
        <button type="button" className={button} disabled={!!busy[key] || !ready || !!validation} aria-busy={busy[key] === 'test'} onClick={() => void act('test')}>
          {busy[key] === 'test' && <CircleNotch className="animate-spin w-3.5 h-3.5" />}{busy[key] === 'test' ? 'Отправляем запрос…' : 'Тестовый запрос'}
        </button>
      </div>
      {!check && <p className="text-[11px] text-neutral-400">Сначала нажмите «Проверить CLI».</p>}
      {check?.auth === 'required' && <p className="text-[11px] text-neutral-400">Выполните вход в CLI, затем повторите проверку.</p>}
      <p className="text-[11px] text-neutral-500">Изменения настроек сохраняются автоматически. «Проверить CLI» проверяет текущий путь без запроса модели. «Тестовый запрос» отправляет один короткий запрос текущей модели; у платных моделей он тарифицируется. Проверки не меняют настройки, ответ теста не сохраняется.</p>
      {check?.available && check.auth === 'unknown' && <p className="text-[11px] text-neutral-400">CLI не сообщает статус входа. {status.ready ? 'Доступ к выбранной модели подтверждён ответом.' : 'Доступ к выбранной модели проверяется тестовым запросом.'}</p>}
      <p className="text-[11px] text-neutral-400">При ошибке CLI генерация остановится — автоматического переключения на другой провайдер нет.</p>
      <div aria-live="polite" aria-atomic="true" className="text-[11px] text-neutral-300 space-y-1 break-words">
        {check && <><p className="font-mono break-all">{check.path}</p><p>{check.version}</p><p>Вход: {check.auth === 'authenticated' ? 'выполнен' : check.auth === 'required' ? 'нужен вход' : 'неизвестен'}</p><p>Проверено в {time(check.checked_at)}</p></>}
        {list && <p>Получено моделей: {list.models.length}</p>}
        {list?.error && <p className="text-amber-400">Список моделей: {list.error}</p>}
        {test && <p className={test.ok ? 'text-emerald-400' : 'text-rose-400'}>{test.ok ? `Модель ответила за ${test.elapsed_ms} мс${preview ? `: ${preview}` : ''}` : 'Запрос к модели не выполнен'} · {time(test.tested_at)}</p>}
        {error && <p className="text-rose-400">{error}</p>}
      </div>
      {error && <details className="text-[11px] text-neutral-500"><summary className="min-h-7 cursor-pointer">Вывод CLI</summary><pre className="whitespace-pre-wrap break-all max-h-40 overflow-auto">{error.slice(0, 2048)}</pre></details>}
    </div>
  </div>;
}
