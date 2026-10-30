import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationRetry, canChooseGenerationRoute, generationModelLabel } from '../src/utils/generationRetry.ts';
import { api } from '../src/services/api.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const route = (provider, model = '', mode = 'cli') => ({ mode, provider, model });
const options = () => ({
  default: route('opencode', 'saved/default'),
  providers: [
    { ...route('api', 'saved-api', 'api'), label: 'API из настроек', requires_model: true, supports_models: true },
    { ...route('opencode', 'saved/default'), label: 'OpenCode', requires_model: true, supports_models: true },
    { ...route('codex'), label: 'Codex CLI', requires_model: false, supports_models: false },
    { ...route('claude', 'saved-claude'), label: 'Claude Code', requires_model: false, supports_models: false },
    { ...route('antigravity'), label: 'Antigravity', requires_model: false, supports_models: true },
  ],
  last_attempt: { ...route('opencode', 'prov/failed#free'), id: 'last', started_at: '2026-10-30' },
});
const list = (provider, ids = ['prov/a']) => ({ provider, models: ids.map(id => ({ id, free: null })), pricing_available: false, fetched_at: '2026-10-30T12:00:00Z' });
function fixture(overrides = {}) {
  const calls = [];
  const controller = createGenerationRetry({ options: async () => options(), models: async option => list(option.provider), start: async route => { calls.push(route); }, ...overrides });
  return { controller, calls };
}

test('failed route is initialized exactly; provider drafts/list survive switches; no auto generation', async () => {
  const { controller: c, calls } = fixture();
  await c.open();
  assert.equal(c.getSnapshot().drafts['cli:opencode'].model, 'prov/failed#free');
  c.model('prov/next#high'); await c.loadModels();
  assert.equal(c.getSnapshot().drafts['cli:opencode'].model, 'prov/next#high');
  c.select('cli:claude'); c.model('other'); c.select('cli:opencode');
  assert.equal(c.getSnapshot().drafts['cli:opencode'].model, 'prov/next#high');
  assert.equal(c.getSnapshot().drafts['cli:opencode'].list.models.length, 1);
  assert.deepEqual(calls, []);
  c.select('cli:codex'); await c.start();
  assert.deepEqual(calls, [route('codex', '')]); assert.equal(c.getSnapshot().open, false);
});

test('required model validation, exact variants and 409 retain draft for explicit retry', async () => {
  let failure = true; const calls = [];
  const { controller: c } = fixture({ start: async value => { calls.push(value); if (failure) throw Error('Обработка уже выполняется'); } });
  await c.open(); c.select('api:api'); c.model('   '); await c.start(); assert.equal(calls.length, 0);
  c.select('cli:opencode'); c.model('prov/m#high'); await c.start();
  assert.equal(c.getSnapshot().open, true); assert.equal(c.getSnapshot().starting, false);
  assert.equal(c.getSnapshot().drafts['cli:opencode'].model, 'prov/m#high');
  assert.match(c.getSnapshot().startError, /Обработка/);
  c.model('prov/m#next'); assert.equal(c.getSnapshot().startError, '');
  failure = false; await c.start(); assert.deepEqual(calls, [route('opencode', 'prov/m#high'), route('opencode', 'prov/m#next')]);
});

test('empty/error discovery keeps manual input and exact model; missing model stays selectable', async () => {
  for (const models of [async () => list('opencode', []), async () => ({ ...list('opencode'), error: 'Нужен вход' }), async () => { throw Error('CLI не найден'); }]) {
    const { controller: c } = fixture({ models }); await c.open(); await c.loadModels();
    const draft = c.getSnapshot().drafts['cli:opencode'];
    assert.equal(draft.manual, true); assert.equal(draft.model, 'prov/failed#free'); assert.match(draft.listError, /Модель можно ввести вручную/);
  }
});

test('fences provider A→B→A, duplicate discovery, close/reopen and late options', async () => {
  const first = deferred(), second = deferred(), third = deferred(); let i = 0;
  const { controller: c } = fixture({ models: () => [first, second, third][i++].promise });
  await c.open(); const a = c.loadModels(); c.select('cli:antigravity'); c.select('cli:opencode');
  first.resolve(list('opencode', ['stale'])); await a;
  assert.equal(c.getSnapshot().drafts['cli:opencode'].list, undefined);
  const b = c.loadModels(), d = c.loadModels(); third.resolve(list('opencode', ['new'])); await d;
  second.resolve(list('opencode', ['old'])); await b;
  assert.equal(c.getSnapshot().drafts['cli:opencode'].list.models[0].id, 'new');
  c.close(); await c.open(); assert.equal(c.getSnapshot().drafts['cli:opencode'].list, undefined);
  const waiting = deferred(); const f = fixture({ options: () => waiting.promise }).controller;
  const pending = f.open(); f.close(); waiting.resolve(options()); await pending; assert.equal(f.getSnapshot().open, false);
});

test('double start sends once; unmount/meeting change prevents late success/error from restoring draft', async () => {
  const pending = deferred(); let calls = 0;
  const { controller: old } = fixture({ start: async () => { calls++; await pending.promise; } });
  const { controller: next } = fixture();
  await old.open(); const start = old.start(); await old.start(); assert.equal(calls, 1);
  old.close(); await next.open(); next.model('next/own'); pending.reject(Error('old meeting')); await start;
  assert.equal(old.getSnapshot().open, false); assert.equal(next.getSnapshot().drafts['cli:opencode'].model, 'next/own');
});

test('route picker exists only for eligible states with transcript, never while stopping', () => {
  for (const status of ['transcribed', 'error', 'cancelled']) assert.equal(canChooseGenerationRoute(status, ' text '), true);
  for (const status of ['draft', 'transcribing', 'generating', 'cancelling', 'completed']) assert.equal(canChooseGenerationRoute(status, 'text'), false);
  assert.equal(canChooseGenerationRoute('error', '  '), false); assert.equal(canChooseGenerationRoute('error', 'text', true), false);
  assert.equal(generationModelLabel(route('api', '', 'api')), 'модель не указана');
  assert.equal(generationModelLabel(route('codex')), 'модель по умолчанию CLI');
});

test('API wire: whitelist fields, no-body compatibility, safe discovery queries and backend details', async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => { requests.push([String(url), init]); return Response.json({ meeting_id: 'm', status: 'generating' }); };
  try {
    await api.generate('m', { ...route('opencode', 'p/m#exact'), api_key: 'must-not-send', path: '/private', url: 'https://private' });
    assert.deepEqual(JSON.parse(requests[0][1].body), route('opencode', 'p/m#exact'));
    await api.generate('m'); assert.equal(requests[1][1].body, undefined); assert.equal(requests[1][1].headers, undefined);
    await api.generate('m', route('codex', '')); assert.equal(JSON.parse(requests[2][1].body).model, '');
    await api.generationModels('m', 'api', 'api'); assert.match(requests[3][0], /generation-models\?mode=api$/);
    await api.generationModels('m', 'cli', 'antigravity'); assert.match(requests[4][0], /mode=cli&provider=antigravity$/);
    for (const status of [409, 422]) {
      globalThis.fetch = async () => Response.json({ detail: 'Выберите модель' }, { status });
      await assert.rejects(api.generate('m', route('codex')), /Выберите модель/);
    }
    globalThis.fetch = async () => new Response('not JSON', { status: 500 }); await assert.rejects(api.generationOptions('m'), /HTTP 500/);
    assert.ok(requests.every(([url]) => !url.includes('/system/config') && !url.endsWith('/transcribe')));
  } finally { globalThis.fetch = original; }
});
