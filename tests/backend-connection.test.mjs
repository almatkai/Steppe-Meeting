import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/services/api.ts';

test('Unavailable backend gives an actionable error for STT and templates, then recovers on retry', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Load failed'); };
    for (const request of [() => api.getWhisperStatus(), () => api.listTemplates()]) {
      await assert.rejects(request(), /Локальный сервер недоступен.*8008/);
    }
    globalThis.fetch = async () => Response.json({ local: { catalog: [{ id: 'small' }] } });
    assert.equal((await api.getWhisperStatus()).local.catalog[0].id, 'small');
  } finally { globalThis.fetch = original; }
});

test('Settings reads have a deadline even if the local server stalls', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.ok(options?.signal instanceof AbortSignal);
      throw new DOMException('timed out', 'TimeoutError');
    };
    await assert.rejects(api.getWhisperStatus(), /не ответил.*Повторите/);
  } finally { globalThis.fetch = original; }
});

test('Native webviews coalesce concurrent startup and retry a failed startup', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let starts = 0;
  let fail = true;
  try {
    globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command) => {
      assert.equal(command, 'ensure_backend');
      starts++;
      if (fail) throw 'Python setup failed; see backend.log';
    } } };
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(api.getConfig(), /Python setup failed/);
    fail = false;
    await Promise.all([api.getConfig(), api.getWhisperStatus(), api.listTemplates()]);
    assert.equal(starts, 2);
    globalThis.fetch = async () => { throw new TypeError('Load failed'); };
    await assert.rejects(api.getConfig(), /Локальный сервер недоступен/);
    globalThis.fetch = async () => Response.json({});
    await api.getConfig();
    assert.equal(starts, 3);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});
