import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsAutosave, configDiff } from '../src/utils/settingsAutosave.ts';

const config = () => ({
  update_channel: 'stable', llm_mode: 'api', llm_cli_provider: 'opencode', llm_cli: { codex: { path: '/usr/bin/codex', model: 'original' } },
  llm_base_url: 'http://localhost:11434/v1', llm_model: 'local', llm_api_key: 'secret',
  whisper_mode: 'local', whisper_local_model: 'small', whisper_device: 'auto',
  whisper_base_url: 'http://localhost:8000/v1', whisper_model: 'whisper-1', whisper_api_key: '',
});
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const edit = (queue, patch, debounce = false) => queue.change({ ...queue.getSnapshot().config, ...patch }, debounce);

test('Loading never writes defaults; typing coalesces at 500 ms and blur flushes immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const q = createSettingsAutosave(async patch => { writes.push(patch); });
  q.change(config());
  q.hydrate(config());
  assert.equal(writes.length, 0);
  edit(q, { llm_model: 'f' }, true);
  t.mock.timers.tick(400);
  edit(q, { llm_model: 'final' }, true);
  t.mock.timers.tick(499);
  assert.equal(writes.length, 0);
  assert.equal(q.getSnapshot().llm.status, 'pending');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(writes, [{ llm_model: 'final' }]);
  assert.equal(q.getSnapshot().llm.status, 'saved');
  edit(q, { llm_api_key: 'new key' }, true);
  q.flush();
  await settle();
  assert.deepEqual(writes.at(-1), { llm_api_key: 'new key' });
});

test('Writes serialize and coalesce: slow acknowledgement cannot rewind a newer choice', async () => {
  const writes = [], requests = [];
  const q = createSettingsAutosave(patch => { writes.push(patch); const request = deferred(); requests.push(request); return request.promise; });
  q.hydrate(config());
  edit(q, { llm_model: 'first' });
  edit(q, { llm_model: 'second' });
  edit(q, { llm_model: 'latest' });
  assert.equal(writes.length, 1);
  requests[0].resolve();
  await settle();
  assert.equal(q.getSnapshot().config.llm_model, 'latest');
  assert.deepEqual(writes, [{ llm_model: 'first' }, { llm_model: 'latest' }]);
  requests[1].resolve();
  await settle();
  assert.equal(q.getSnapshot().llm.status, 'saved');
});

test('Reverting to the original value during a write still persists the final value', async () => {
  const first = deferred(), writes = [];
  const q = createSettingsAutosave(patch => { writes.push(patch); return writes.length === 1 ? first.promise : Promise.resolve(); });
  q.hydrate(config());
  edit(q, { llm_model: 'temporary' });
  edit(q, { llm_model: 'local' });
  first.resolve();
  await settle();
  assert.deepEqual(writes, [{ llm_model: 'temporary' }, { llm_model: 'local' }]);
  assert.equal(q.getSnapshot().llm.status, 'saved');
});

test('Retry reconciles a reverted value after the server commits but its response is lost', async () => {
  const first = deferred(), writes = [];
  let server = config();
  const q = createSettingsAutosave(patch => {
    writes.push(patch); server = { ...server, ...patch };
    return writes.length === 1 ? first.promise : Promise.resolve();
  });
  q.hydrate(config());
  edit(q, { llm_model: 'temporary' });
  edit(q, { llm_model: 'local' });
  first.reject(new Error('response lost'));
  await settle();
  assert.equal(q.getSnapshot().llm.status, 'error');
  q.retry('llm'); await settle();
  assert.equal(server.llm_model, 'local');
  assert.deepEqual(writes, [{ llm_model: 'temporary' }, { llm_model: 'local' }]);
  assert.equal(q.getSnapshot().llm.status, 'saved');
});

test('Invalid LLM drafts stay pending; independent STT changes save; dependent CLI fields save together', async () => {
  const writes = [];
  const q = createSettingsAutosave(async patch => { writes.push(patch); });
  q.hydrate(config());
  edit(q, { llm_mode: 'cli' });
  assert.match(q.getSnapshot().llm.validation, /модель OpenCode/);
  edit(q, { whisper_local_model: 'vosk-small-ru' });
  await settle();
  assert.deepEqual(writes, [{ whisper_local_model: 'vosk-small-ru' }]);
  assert.equal(q.getSnapshot().llm.status, 'pending');
  edit(q, { llm_cli: { ...q.getSnapshot().config.llm_cli, opencode: { model: 'ollama/local#precise', path: 'relative' } } });
  q.flush();
  assert.match(q.getSnapshot().llm.validation, /начинаться/);
  assert.equal(writes.length, 1);
  edit(q, { llm_cli: { ...q.getSnapshot().config.llm_cli, opencode: { model: 'ollama/local#precise', path: '/opt/opencode' } } });
  await settle();
  assert.deepEqual(writes[1], { llm_mode: 'cli', llm_cli: { opencode: { model: 'ollama/local#precise', path: '/opt/opencode' } } });
  assert.deepEqual(q.getSnapshot().config.llm_cli.codex, config().llm_cli.codex);
  assert.equal(q.getSnapshot().config.llm_api_key, 'secret');
});

test('Invalid API URL / empty model cannot write; changing a preset commits both valid fields', async () => {
  const writes = [];
  const q = createSettingsAutosave(async patch => { writes.push(patch); });
  q.hydrate(config());
  edit(q, { llm_base_url: 'https://' }); q.flush(); await settle();
  assert.match(q.getSnapshot().llm.validation, /HTTP/);
  edit(q, { llm_base_url: 'https://provider.example/v1', llm_model: '' });
  await settle();
  assert.match(q.getSnapshot().llm.validation, /модель/);
  assert.equal(writes.length, 0);
  edit(q, { llm_model: 'valid-model' });
  await settle();
  assert.deepEqual(writes, [{ llm_base_url: 'https://provider.example/v1', llm_model: 'valid-model' }]);
});

test('Failure never says saved; retry persists latest draft and does not block the STT group', async () => {
  const writes = []; let fail = true;
  const q = createSettingsAutosave(async patch => { writes.push(patch); if ('llm_model' in patch && fail) throw new Error('disk unavailable'); });
  q.hydrate(config());
  edit(q, { llm_model: 'changed' }); await settle();
  assert.equal(q.getSnapshot().llm.status, 'error');
  assert.match(q.getSnapshot().llm.error, /disk unavailable/);
  q.flush(); await settle();
  assert.equal(writes.length, 1); // blur/navigation is not an automatic retry loop
  edit(q, { whisper_device: 'cpu' }); await settle();
  assert.deepEqual(writes[1], { whisper_device: 'cpu' });
  assert.equal(q.getSnapshot().llm.status, 'error');
  fail = false;
  q.retry('llm'); await settle();
  assert.deepEqual(writes.at(-1), { llm_model: 'changed' });
  assert.equal(q.getSnapshot().llm.status, 'saved');
});

test('Navigation unsubscribes UI, flushes text, and retains invalid drafts when mounted again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [], q = createSettingsAutosave(async patch => { writes.push(patch); });
  q.hydrate(config());
  let renders = 0;
  const leave = q.subscribe(() => renders++);
  edit(q, { llm_api_key: 'pending text' }, true);
  leave(); q.flush(); await settle();
  assert.deepEqual(writes, [{ llm_api_key: 'pending text' }]);
  const renderCount = renders;
  edit(q, { llm_base_url: 'invalid' }, true);
  q.flush(); await settle();
  assert.equal(renders, renderCount);
  q.hydrate({ ...config(), llm_api_key: 'pending text', whisper_local_model: 'large', update_channel: 'beta' });
  assert.equal(q.getSnapshot().config.llm_base_url, 'invalid');
  assert.match(q.getSnapshot().llm.validation, /HTTP/);
  assert.equal(q.getSnapshot().config.whisper_local_model, 'large');
});

test('Shared Mini STT and update channel changes survive LLM patches; nested CLI patch changes only one option', async () => {
  let server = config();
  const writes = [];
  const q = createSettingsAutosave(async patch => { writes.push(patch); server = { ...server, ...patch }; });
  q.hydrate(server);
  server = { ...server, whisper_local_model: 'mini-selected', update_channel: 'beta' };
  edit(q, { llm_model: 'new model' }); await settle();
  assert.equal(server.whisper_local_model, 'mini-selected');
  assert.equal(server.update_channel, 'beta');
  assert.deepEqual(writes, [{ llm_model: 'new model' }]);
  const original = config();
  assert.deepEqual(configDiff(original, { ...original, llm_cli: { codex: { ...original.llm_cli.codex, model: 'new' } }, update_channel: 'beta' }), { llm_cli: { codex: { model: 'new' } } });
});

test('A slow earlier write does not shorten the debounce of later typing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred(), writes = [];
  const q = createSettingsAutosave(patch => { writes.push(patch); return writes.length === 1 ? first.promise : Promise.resolve(); });
  q.hydrate(config());
  edit(q, { llm_model: 'first' });
  edit(q, { llm_model: 'typing' }, true);
  first.resolve(); await settle();
  assert.equal(q.getSnapshot().config.llm_model, 'typing');
  assert.equal(q.getSnapshot().llm.status, 'pending');
  assert.equal(writes.length, 1);
  t.mock.timers.tick(500); await settle();
  assert.deepEqual(writes.at(-1), { llm_model: 'typing' });
});

test('Switching CLI providers and back to API preserves each provider path, model, and API credentials', async () => {
  const q = createSettingsAutosave(async () => {});
  q.hydrate({ ...config(), llm_cli: { ...config().llm_cli, opencode: { model: 'ollama/local', path: '/opt/opencode' } } });
  edit(q, { llm_mode: 'cli', llm_cli_provider: 'codex' }); await settle();
  edit(q, { llm_cli: { ...q.getSnapshot().config.llm_cli, codex: { path: '/other/codex', model: 'custom' } } }); await settle();
  edit(q, { llm_cli_provider: 'opencode' }); await settle();
  assert.deepEqual(q.getSnapshot().config.llm_cli.opencode, { model: 'ollama/local', path: '/opt/opencode' });
  edit(q, { llm_mode: 'api' }); await settle();
  assert.equal(q.getSnapshot().config.llm_api_key, 'secret');
  assert.equal(q.getSnapshot().config.llm_base_url, config().llm_base_url);
  assert.deepEqual(q.getSnapshot().config.llm_cli.codex, { path: '/other/codex', model: 'custom' });
});

test('Refresh coalesces and reconciles shared config, but a late GET cannot rewind newer edits or acknowledgements', async () => {
  const q = createSettingsAutosave(async () => {});
  let reads = 0;
  const initial = deferred();
  const read = () => { reads++; return initial.promise; };
  const one = q.refresh(read), two = q.refresh(read);
  await settle();
  assert.equal(reads, 1);
  initial.resolve(config()); await Promise.all([one, two]);
  const stale = deferred(), loading = q.refresh(() => stale.promise);
  edit(q, { llm_model: 'newer edit' }); await settle();
  stale.resolve(config()); await loading;
  assert.equal(q.getSnapshot().config.llm_model, 'newer edit');
  assert.equal(q.getSnapshot().llm.status, 'saved');
  await q.refresh(async () => ({ ...config(), llm_model: 'newer edit', whisper_local_model: 'mini model', update_channel: 'beta' }));
  assert.equal(q.getSnapshot().config.whisper_local_model, 'mini model');
  assert.equal(q.getSnapshot().config.update_channel, 'beta');
});

test('Discovery waits for current form autosave without forcing a write; invalid/error drafts reject discovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [], q = createSettingsAutosave(async patch => { writes.push(patch); });
  q.hydrate(config());
  edit(q, { llm_base_url: 'https://new.example/v1' }, true);
  let settled = false;
  const discovery = q.waitForSaved('llm').then(() => { settled = true; });
  await settle();
  assert.equal(writes.length, 0);
  assert.equal(settled, false);
  t.mock.timers.tick(500); await discovery;
  assert.deepEqual(writes, [{ llm_base_url: 'https://new.example/v1' }]);
  edit(q, { llm_model: '' });
  await assert.rejects(q.waitForSaved('llm'), /модель/);
  assert.equal(writes.length, 1);
});
