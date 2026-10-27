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

export function cliStatus(check?: CliCheckResult) {
  if (!check) return 'Не проверен';
  if (!check.available) return check.path ? 'Недоступно' : 'Не найден';
  if (check.auth === 'required') return 'Нужен вход';
  return check.auth === 'authenticated' ? 'Готов' : 'Найден, вход неизвестен';
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
