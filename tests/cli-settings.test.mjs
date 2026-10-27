import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliCheckKey, cliExecutableLabel, cliKey, cliModelName, cliModelVisibility, cliReadiness, mergeCliCheck, cliStatus } from '../src/utils/cliSettings.ts';

const checked = (auth = 'unknown', configured_path = '') => ({
  provider: 'antigravity', configured_path, available: true, path: '/usr/local/bin/agy',
  auth, supports_models: true, checked_at: '2026-10-27T00:00:00Z',
});

test('Unchecked, missing, unsigned-in and unknown-login CLIs have distinct honest states', () => {
  assert.match(cliExecutableLabel(), /Не проверен/);
  assert.doesNotMatch(cliExecutableLabel(), /Не найден/);
  assert.equal(cliStatus(), 'Не проверен');
  assert.equal(cliStatus({ ...checked(), available: false, path: undefined }), 'Не найден');
  assert.equal(cliStatus(checked('required')), 'Нужен вход');
  assert.equal(cliStatus(checked()), 'Доступ к модели не проверен');
  assert.equal(cliStatus(checked('authenticated')), 'Вход выполнен, модель не проверена');
  assert.equal(cliExecutableLabel(checked()), '/usr/local/bin/agy');
  assert.equal(cliModelName('CLI default'), 'модель CLI по умолчанию');
});

test('Saved status belongs to the configured override, not the resolved executable or unsaved edits', () => {
  const config = { llm_cli_provider: 'antigravity', llm_cli: {} };
  const automatic = checked();
  assert.equal(cliCheckKey(automatic), cliKey(config));
  const custom = { ...config, llm_cli: { antigravity: { path: '/custom/agy' } } };
  assert.notEqual(cliCheckKey(automatic), cliKey(custom));
  assert.equal(cliCheckKey(checked('unknown', '/custom/agy')), cliKey(custom));
  assert.notEqual(cliCheckKey(automatic), cliKey({ llm_cli_provider: 'codex', llm_cli: {} }));
});

test('A saved paid model hidden by a free filter stays distinct from a missing model', () => {
  const models = [{ id: 'provider/paid', free: false }, { id: 'provider/free', free: true }];
  const visible = models.filter(model => model.free === true);
  assert.equal(cliModelVisibility('provider/paid', models, visible), 'filtered');
  assert.equal(cliModelVisibility('provider/removed', models, visible), 'missing');
  assert.equal(cliModelVisibility('provider/free', models, visible), 'visible');
});

const access = (ok = true, model = '', tested_at = '2026-10-28T00:00:00Z') => ({
  ok, model, path: '/usr/local/bin/agy', tested_at, elapsed_ms: 12,
  ...(ok ? {} : { error: 'Модель недоступна' }),
});
test('All providers share exact model/executable readiness without claiming a confirmed login', () => {
  for (const provider of ['opencode', 'codex', 'claude', 'antigravity']) {
    const check = { ...checked(), provider, model_access: access(true, 'chosen#variant') };
    assert.equal(cliReadiness(check, 'chosen#variant').ready, true);
    assert.equal(cliStatus(check, 'chosen#variant'), 'Модель отвечает');
    assert.equal(check.auth, 'unknown');
    for (const model of ['', 'CLI default', 'other', 'chosen#other']) {
      assert.equal(cliReadiness(check, model).ready, false);
    }
    assert.equal(cliReadiness({ ...check, model_access: access() }, '').ready, true);
    assert.equal(cliReadiness({ ...check, model_access: access() }, 'CLI default').ready, false);
    for (const change of [{ available: false }, { auth: 'required' }, { error: 'Проверка не удалась' }, { path: '/changed/agy' }]) {
      assert.equal(cliReadiness({ ...check, ...change }, 'chosen#variant').ready, false);
    }
    assert.equal(cliReadiness({ ...check, model_access: access(false, 'chosen#variant') }, 'chosen#variant').tone, 'error');
  }
});
test('Polls retain newer failures and explicit checks, but do not carry success to a different executable', () => {
  const passed = { ...checked(), model_access: access() };
  const failed = { ...checked(), model_access: access(false, '', '2026-10-28T00:01:00Z') };
  assert.equal(mergeCliCheck(failed, passed).model_access.ok, false);
  assert.equal(mergeCliCheck(passed, failed).model_access.ok, false);
  const broken = { ...checked(), checked_at: '2026-10-29T00:00:00Z', error: 'Не запускается' };
  assert.equal(cliReadiness(mergeCliCheck(broken, passed), '').ready, false);
  assert.equal(cliReadiness(mergeCliCheck(passed, { ...checked(), path: '/different', checked_at: '2026-10-30T00:00:00Z' }), '').ready, false);
});

test('A fresh unresolved executable failure replaces success; a newly resolved executable needs its own probe', () => {
  const passed = { ...checked(), model_access: access() };
  const failed = { ...passed, model_access: { ...access(false, '', '2026-10-28T00:01:00Z'), path: '' } };
  assert.equal(cliReadiness(mergeCliCheck(passed, failed)).tone, 'error');
  const changed = { ...passed, model_access: { ...access(true, '', '2026-10-28T00:02:00Z'), path: '/other' } };
  assert.equal(cliReadiness(mergeCliCheck(passed, changed)).ready, false);
});

test('A cached pass in the same clock millisecond cannot replace a fresh failure', () => {
  const passed = { ...checked(), model_access: access() };
  const failed = { ...checked(), model_access: access(false) };
  assert.equal(cliReadiness(mergeCliCheck(passed, failed)).ready, false);
  assert.equal(cliReadiness(mergeCliCheck(failed, passed)).ready, false);
});
