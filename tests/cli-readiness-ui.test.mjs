import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the real components and exercise the real shared store without a
// browser, server, extra test framework or access to the user's settings.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.conditions.includes('import')) {
      const resolved = next(specifier, context);
      // These desktop views are client-only. Render their current snapshots
      // rather than Zustand's initial server snapshot.
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(
        `import React from ${JSON.stringify(resolved.url)}; export * from ${JSON.stringify(resolved.url)};
         export const useSyncExternalStore = (s, g) => React.useSyncExternalStore(s, g, g);
         export default { ...React, useSyncExternalStore };`) };
    }
    if (specifier === 'file-saver') {
      const resolved = next(specifier, context);
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(
        `import saver from ${JSON.stringify(resolved.url)}; export const saveAs = saver.saveAs;`) };
    }
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/package.json')) return { format: 'module', shortCircuit: true,
      source: 'export const version = ' + JSON.stringify(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')).version) + ';' };
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).outputText };
    return next(url, context);
  },
});
const { CliSettings } = await import('../src/components/settings/CliSettings.tsx');
const { SettingsView } = await import('../src/components/settings/SettingsView.tsx');
const { AppSidebar } = await import('../src/components/layout/AppSidebar.tsx');
const { useMeetingStore } = await import('../src/store/useMeetingStore.ts');
const { settingsAutosave } = await import('../src/store/settingsStore.ts');
const { cliKey, cliReadiness } = await import('../src/utils/cliSettings.ts');
const { api } = await import('../src/services/api.ts');
const providers = ['opencode', 'codex', 'claude', 'antigravity'];
const configFor = provider => ({ llm_mode: 'cli', llm_cli_provider: provider,
  llm_cli: { [provider]: { model: provider === 'opencode' ? 'provider/model#variant' : '' } },
  llm_base_url: '', llm_model: '', whisper_mode: 'local', whisper_local_model: 'small' });
const checkFor = config => ({ provider: config.llm_cli_provider, configured_path: '', path: '/test/cli',
  available: true, auth: 'unknown', supports_models: false, checked_at: '2026-10-28T00:00:00Z',
  model_access: { model: config.llm_cli[config.llm_cli_provider].model, path: '/test/cli', ok: true,
    elapsed_ms: 12, tested_at: '2026-10-28T00:01:00Z' } });
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props));

test('All CLI forms, settings headers and sidebar agree after success with unknown login', () => {
  for (const provider of providers) {
    const config = configFor(provider), check = checkFor(config), key = cliKey(config);
    const checks = { [key]: check };
    useMeetingStore.setState({ cliChecks: checks, systemStatus: null });
    settingsAutosave.hydrate(config);
    const form = render(CliSettings, { config, checks, onChange() {}, onCheck() {}, onAccess() {} });
    const header = render(SettingsView), sidebar = render(AppSidebar);
    for (const html of [form, header, sidebar]) {
      assert.match(html, /Модель отвечает/);
      assert.doesNotMatch(html, /Выполните вход|готовность не подтверждена|Тест не выполнен/);
    }
    assert.match(form, /Вход: неизвестен/);
    assert.match(form, /Модель ответила за 12 мс/);
  }
});

test('Shared runtime state survives remount/polls; fresh failures and edited identities invalidate all surfaces', async () => {
  const config = configFor('antigravity'), key = cliKey(config), check = checkFor(config);
  const original = api.getSystemStatus;
  try {
    useMeetingStore.setState({ cliChecks: {}, systemStatus: null });
    useMeetingStore.getState().setCliCheck(key, { ...check, model_access: undefined });
    useMeetingStore.getState().setCliAccess(key, check.model_access);
    settingsAutosave.hydrate(config);
    api.getSystemStatus = async () => ({ llm_mode: 'cli', cli: { ...check, model_access: undefined }, ollama: { model: 'CLI default' } });
    await useMeetingStore.getState().checkStatus();
    assert.match(render(AppSidebar), /Модель отвечает/);
    useMeetingStore.getState().setCliAccess(key, { ...check.model_access, ok: false,
      tested_at: '2026-10-28T00:02:00Z', error: 'Synthetic request failed' });
    await useMeetingStore.getState().checkStatus();
    assert.match(render(AppSidebar), /Ошибка запроса/);
    assert.doesNotMatch(render(SettingsView), /Модель отвечает/);
    assert.equal(cliReadiness(useMeetingStore.getState().cliChecks[key]).ready, false);
    useMeetingStore.getState().setCliCheck(key, check);
    for (const changed of [
      { ...config, llm_cli_provider: 'codex' },
      { ...config, llm_cli: { antigravity: { path: '/other/cli' } } },
      { ...config, llm_cli: { antigravity: { model: 'other-exact-model' } } },
    ]) {
      settingsAutosave.hydrate(changed);
      for (const Component of [SettingsView, AppSidebar]) assert.doesNotMatch(render(Component), /Модель отвечает/);
    }
  } finally { api.getSystemStatus = original; }
});

test('Known login, missing binaries and failed probes stay blocking even with previous successful access', () => {
  const config = configFor('antigravity'), key = cliKey(config);
  settingsAutosave.hydrate(config);
  for (const failure of [
    { auth: 'required', error: 'CLI найден, но вход не выполнен' },
    { available: false, error: 'CLI не найден' },
    { error: 'Проверка CLI не завершена' },
  ]) {
    const check = { ...checkFor(config), ...failure };
    useMeetingStore.setState({ cliChecks: { [key]: check } });
    const form = render(CliSettings, { config, checks: { [key]: check }, onChange() {}, onCheck() {}, onAccess() {} });
    assert.match(form, new RegExp(failure.error));
    assert.match(form, /disabled=""[^>]*>Тестовый запрос/);
    for (const Component of [SettingsView, AppSidebar]) assert.doesNotMatch(render(Component), /Модель отвечает/);
  }
});

test('A failed backend status poll also removes stale readiness', async () => {
  const config = configFor('antigravity'), key = cliKey(config), check = checkFor(config);
  settingsAutosave.hydrate(config);
  useMeetingStore.setState({ cliChecks: { [key]: check } });
  const original = api.getSystemStatus, originalLog = console.error;
  try {
    api.getSystemStatus = async () => { throw new Error('offline'); };
    console.error = () => {};
    await useMeetingStore.getState().checkStatus();
    assert.doesNotMatch(render(AppSidebar), /Модель отвечает/);
    assert.equal(cliReadiness(useMeetingStore.getState().cliChecks[key]).tone, 'error');
  } finally { api.getSystemStatus = original; console.error = originalLog; }
});
