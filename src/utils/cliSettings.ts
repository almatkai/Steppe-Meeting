import type { CliCheckResult, CliModelsResult, SystemConfig } from '../types';

export const cliKey = (config: SystemConfig) => JSON.stringify([
  config.llm_cli_provider, config.llm_cli[config.llm_cli_provider]?.path?.trim() || '',
]);

export const cliCheckKey = (check: CliCheckResult) => JSON.stringify([
  check.provider, check.configured_path?.trim() || '',
]);

export function cliValidation(config: SystemConfig) {
  if (config.llm_mode !== 'cli') return '';
  const options = config.llm_cli[config.llm_cli_provider] || {};
  if (options.path?.trim() && !options.path.trim().startsWith('/')) return 'Путь должен начинаться с /';
  if (config.llm_cli_provider === 'opencode' && !/^[^/\s]+\/[^\s#]+(#[^\s]+)?$/.test(options.model?.trim() || ''))
    return 'Формат: провайдер/модель, например opencode/…';
  return '';
}

// All CLI surfaces derive readiness from the same probe + exact request evidence.
export function cliReadiness(check?: CliCheckResult, model = '') {
  const access = check?.model_access;
  const matching = access && access.model === model.trim() && (access.path === check?.path || !access.ok) ? access : undefined;
  if (!check) return { ready: false, tone: 'neutral', label: 'Не проверен', access: undefined };
  if (!check.available || check.error || check.auth === 'required') return {
    ready: false, tone: check.auth === 'required' ? 'warning' : 'error', access: undefined,
    label: check.auth === 'required' ? 'Нужен вход' : !check.available && !check.path ? 'Не найден' : 'Недоступно',
  };
  if (matching) return { ready: matching.ok, tone: matching.ok ? 'success' : 'error',
    label: matching.ok ? 'Модель отвечает' : 'Ошибка запроса', access: matching };
  return { ready: false, tone: 'neutral', access: undefined,
    label: check.auth === 'authenticated' ? 'Вход выполнен, модель не проверена' : 'Доступ к модели не проверен' };
}

export function cliStatus(check?: CliCheckResult, model = '') {
  return cliReadiness(check, model).label;
}

export function mergeCliCheck(previous: CliCheckResult | undefined, incoming: CliCheckResult): CliCheckResult {
  if (!previous) return incoming;
  const check = Date.parse(previous.checked_at) > Date.parse(incoming.checked_at) ? previous : incoming;
  const accesses = [previous.model_access, incoming.model_access]
    .filter(access => access)
    // Date.parse truncates sub-millisecond backend timestamps. Prefer a failure
    // on ties so a cached pass cannot hide a freshly failed request.
    .sort((a, b) => Date.parse(b!.tested_at) - Date.parse(a!.tested_at) || Number(a!.ok) - Number(b!.ok));
  return { ...check, model_access: accesses[0] };
}

export function cliExecutableLabel(check?: CliCheckResult) {
  if (!check) return 'Не проверен — нажмите «Проверить CLI»';
  return check.path || (check.available ? 'CLI найден' : 'Не найден в PATH и стандартных папках');
}

export function cliModelVisibility(model: string, models: CliModelsResult['models'], visible: CliModelsResult['models']) {
  if (!models.some(item => item.id === model)) return 'missing';
  return visible.some(item => item.id === model) ? 'visible' : 'filtered';
}

export function cliModelName(model?: string) {
  return !model || model === 'CLI default' ? 'модель CLI по умолчанию' : model;
}
