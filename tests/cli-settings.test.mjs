import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliCheckKey, cliExecutableLabel, cliKey, cliModelName, cliModelVisibility, cliStatus } from '../src/utils/cliSettings.ts';

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
  assert.equal(cliStatus(checked()), 'Найден, вход неизвестен');
  assert.equal(cliStatus(checked('authenticated')), 'Готов');
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
