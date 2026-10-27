import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateTracker, safeReleaseUrl, updateStatusText } from '../src/utils/updateTracker.ts';
import { api } from '../src/services/api.ts';

const runtime = { current_version: '0.1.0', platform: 'darwin', arch: 'aarch64' };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const result = (channel = 'stable', status = 'no_releases') => ({ channel, status, repository: 'almatkai/Steppe-Meeting', current_version: '0.1.0', checked_at: new Date().toISOString() });
const deps = (overrides = {}) => ({ runtime: async () => runtime, loadChannel: async () => 'stable', saveChannel: async () => {}, check: async ({ channel }) => result(channel), ...overrides });

test('Concurrent startup checks coalesce, use runtime version/architecture and stored channel, and force is explicit', async () => {
  const request = deferred(), calls = [];
  const tracker = createUpdateTracker(deps({ loadChannel: async () => 'beta', check: query => { calls.push(query); return request.promise; } }));
  const first = tracker.check(), second = tracker.check();
  await settle();
  assert.deepEqual(calls, [{ ...runtime, channel: 'beta', force: false }]);
  request.resolve(result('beta'));
  await Promise.all([first, second]);
  assert.equal(tracker.getSnapshot().result.status, 'no_releases');
  await tracker.check(true);
  assert.equal(calls.at(-1).force, true);
});

test('A slow old channel check cannot overwrite the latest selected channel', async () => {
  const initial = deferred(), beta = deferred(), saves = [], checks = [];
  const tracker = createUpdateTracker(deps({ saveChannel: async channel => saves.push(channel), check: ({ channel }) => { checks.push(channel); return channel === 'stable' ? initial.promise : beta.promise; } }));
  const startup = tracker.check(); await settle();
  tracker.changeChannel('beta'); await settle();
  assert.deepEqual(saves, ['beta']);
  assert.deepEqual(checks, ['stable', 'beta']);
  beta.resolve({ ...result('beta', 'available'), latest_version: '0.2.0-beta.1' }); await settle();
  initial.resolve(result('stable', 'up_to_date')); await startup;
  assert.equal(tracker.getSnapshot().channel, 'beta');
  assert.equal(tracker.getSnapshot().result.latest_version, '0.2.0-beta.1');
  assert.equal(tracker.getSnapshot().checking, false);
});

test('Rapid channel toggles serialize persistence, coalesce to latest and check only after final save', async () => {
  const saving = deferred(), saves = [], checks = [];
  const tracker = createUpdateTracker(deps({ saveChannel: channel => { saves.push(channel); return saves.length === 1 ? saving.promise : Promise.resolve(); }, check: async ({ channel }) => { checks.push(channel); return result(channel); } }));
  await tracker.check();
  tracker.changeChannel('beta'); tracker.changeChannel('stable');
  assert.equal(tracker.getSnapshot().savingChannel, true);
  assert.equal(tracker.getSnapshot().channel, 'stable');
  assert.deepEqual(saves, ['beta']);
  saving.resolve(); await settle();
  assert.deepEqual(saves, ['beta', 'stable']);
  assert.deepEqual(checks, ['stable', 'stable']);
  assert.equal(tracker.getSnapshot().channelSaved, true);
});

test('Channel failure is visible and retry never claims persisted until acknowledged', async () => {
  let fail = true, checks = 0;
  const tracker = createUpdateTracker(deps({ saveChannel: async () => { if (fail) throw new Error('disk error'); }, check: async ({ channel }) => { checks++; return result(channel); } }));
  await tracker.check();
  tracker.changeChannel('beta'); await settle();
  assert.match(tracker.getSnapshot().channelError, /disk error/);
  assert.equal(tracker.getSnapshot().channelSaved, false);
  assert.equal(checks, 1);
  fail = false; tracker.retryChannel(); await settle();
  assert.equal(tracker.getSnapshot().channelError, '');
  assert.equal(tracker.getSnapshot().channelSaved, true);
  assert.equal(tracker.getSnapshot().result.channel, 'beta');
});

test('A lost beta save response cannot falsely mark a rapid return to stable as saved', async () => {
  const first = deferred(), second = deferred(), writes = [];
  let stored = 'stable';
  const tracker = createUpdateTracker(deps({ saveChannel: channel => {
    stored = channel; writes.push(channel);
    return writes.length === 1 ? first.promise : second.promise;
  } }));
  await tracker.check();
  tracker.changeChannel('beta'); tracker.changeChannel('stable');
  first.reject(new Error('response lost')); await settle();
  assert.deepEqual(writes, ['beta', 'stable']);
  assert.equal(tracker.getSnapshot().channelSaved, false);
  second.resolve(); await settle();
  assert.equal(stored, 'stable');
  assert.equal(tracker.getSnapshot().channelSaved, true);
});

test('Cached GitHub quota errors use their absolute retry deadline', () => {
  const retryAt = '2026-10-27T12:15:00Z';
  const value = { ...result('stable', 'error'), checked_at: '2026-10-27T12:00:00Z',
    error: 'GitHub ограничил проверку обновлений. Повторите попытку позже.', retry_after: 30, retry_at: retryAt };
  const label = updateStatusText(value);
  assert.match(label, /^Лимит GitHub API, повторите после/);
  assert.ok(label.includes(new Date(retryAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })));
});

test('Honest empty/offline/rate-limit states and safe release URL allowlist', () => {
  assert.equal(updateStatusText(result()), 'Релизов на GitHub пока нет');
  assert.equal(updateStatusText(result('stable', 'up_to_date')), 'Установлена последняя версия');
  assert.equal(updateStatusText({ ...result('stable', 'error'), error: 'Не удалось связаться с GitHub' }), 'Нет подключения к GitHub');
  assert.match(updateStatusText({ ...result('stable', 'error'), error: 'Лимит GitHub API', retry_after: 60 }), /^Лимит GitHub API, повторите после/);
  const valid = 'https://github.com/almatkai/Steppe-Meeting/releases/tag/v0.2.0';
  assert.equal(safeReleaseUrl(valid), valid);
  for (const url of ['javascript:alert(1)', 'file:///tmp/release', 'https://github.com.evil.test/almatkai/Steppe-Meeting/releases', 'https://github.com/another/repo/releases', 'https://user:pass@github.com/almatkai/Steppe-Meeting/releases', valid + '?redirect=evil', 'https://github.com/almatkai/Steppe-Meeting/releases/download/file']) assert.equal(safeReleaseUrl(url), null);
});

test('Network errors clear a previously available update and retry recovers; missing runtime is never invented', async () => {
  let fail = false;
  const tracker = createUpdateTracker(deps({ check: async ({ channel }) => { if (fail) throw new Error('offline'); return result(channel, 'available'); } }));
  await tracker.check(); fail = true; await tracker.check(true);
  assert.equal(tracker.getSnapshot().result, null);
  assert.equal(tracker.getSnapshot().error, 'offline');
  fail = false; await tracker.check(true);
  assert.equal(tracker.getSnapshot().result.status, 'available');
  const unknown = createUpdateTracker(deps({ runtime: async () => { throw new Error('getVersion failed'); } }));
  await unknown.check();
  assert.equal(unknown.getSnapshot().runtime, null);
  assert.match(unknown.getSnapshot().error, /getVersion/);
});

test('Update API sends narrow channel write and runtime query with a 20-second request deadline', async () => {
  const original = globalThis.fetch, timeout = AbortSignal.timeout, calls = [], deadlines = [];
  try {
    AbortSignal.timeout = ms => { deadlines.push(ms); return new AbortController().signal; };
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options }); return Response.json(result('beta')); };
    await api.checkUpdates({ ...runtime, channel: 'beta', force: true });
    await api.saveUpdateChannel('beta');
    const query = new URL(calls[0].url).searchParams;
    assert.equal(query.get('current_version'), '0.1.0');
    assert.equal(query.get('arch'), 'aarch64');
    assert.equal(query.get('force'), 'true');
    assert.deepEqual(JSON.parse(calls[1].body), { channel: 'beta' });
    assert.ok(calls[1].url.endsWith('/updates/channel'));
    assert.deepEqual(deadlines, [20000, 15000]);
  } finally { globalThis.fetch = original; AbortSignal.timeout = timeout; }
});

test('A mismatched or missing save acknowledgement is an error, never a saved claim', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ channel: 'stable' });
    await assert.rejects(api.saveUpdateChannel('beta'), /не подтвердил канал/);
    globalThis.fetch = async () => Response.json({ success: false });
    await assert.rejects(api.saveConfig({ llm_model: 'draft' }), /не подтвердил сохранение/);
    globalThis.fetch = async () => Response.json({ success: true });
    assert.deepEqual(await api.saveConfig({ whisper_device: 'cpu' }), { success: true });
  } finally { globalThis.fetch = original; }
});

test('A synchronous request failure does not stick the coalescing slot or prevent retry', async () => {
  let fail = true;
  const tracker = createUpdateTracker(deps({ check: ({ channel }) => { if (fail) throw new Error('offline'); return Promise.resolve(result(channel)); } }));
  await tracker.check();
  assert.equal(tracker.getSnapshot().checking, false);
  fail = false; await tracker.check(true);
  assert.equal(tracker.getSnapshot().result.status, 'no_releases');
});
