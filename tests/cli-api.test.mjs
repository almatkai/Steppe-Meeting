import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/services/api.ts';

test('CLI actions send unsaved overrides and exact variants, without saving config', async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({ ok: true, provider: 'opencode', models: [] });
    };
    await api.checkCli('codex', '/unsaved/cli with spaces');
    await api.cliModels('opencode', '/unsaved/opencode');
    await api.testCli('opencode', '/unsaved/opencode', 'ollama/local:latest#precise');
    assert.deepEqual(calls.map(c => c.url.split('/').at(-1)), ['check', 'models', 'test']);
    assert.deepEqual(calls[0].body, { provider: 'codex', path: '/unsaved/cli with spaces' });
    assert.equal(calls[2].body.model, 'ollama/local:latest#precise');
    assert.ok(calls.every(c => !c.url.endsWith('/config')));
    assert.ok(!('model' in calls[0].body));
  } finally { globalThis.fetch = original; }
});

test('CLI errors are surfaced with no automatic model/provider retry', async () => {
  const original = globalThis.fetch;
  let count = 0;
  try {
    globalThis.fetch = async () => { count++; return Response.json({ detail: 'Путь должен начинаться с /' }, { status: 400 }); };
    await assert.rejects(api.checkCli('codex', 'relative'), /Путь должен/);
    assert.equal(count, 1);
  } finally { globalThis.fetch = original; }
});

test('CLI request deadlines allow the full backend budget and session cleanup', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const deadlines = [];
  try {
    AbortSignal.timeout = milliseconds => {
      deadlines.push(milliseconds);
      return new AbortController().signal;
    };
    globalThis.fetch = async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ ok: true });
    };
    await api.checkCli('antigravity');
    await api.cliModels('opencode');
    await api.testCli('antigravity');
    assert.deepEqual(deadlines, [20000, 20000, 75000]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test('CLI timeouts and invalid server responses have actionable Russian errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new DOMException('signal timed out', 'TimeoutError'); };
    await assert.rejects(api.testCli('antigravity'), /CLI не ответил за 75 с/);
    await assert.rejects(api.checkCli('codex'), /CLI не ответил за 20 с/);
    globalThis.fetch = async () => new Response('<html>error</html>', { status: 500 });
    await assert.rejects(api.cliModels('opencode'), /Не удалось выполнить действие CLI \(HTTP 500\)/);
    for (const body of ['<html>not JSON</html>', 'null']) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(api.checkCli('codex'), /CLI вернул некорректный ответ/);
    }
  } finally { globalThis.fetch = original; }
});
