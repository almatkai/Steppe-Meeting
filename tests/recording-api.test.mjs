import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/services/api.ts';

test('Mini sends a JSON completion manifest and reports validation errors clearly', async () => {
  const original = globalThis.fetch;
  const manifest = { session_id: 'session', chunk_count: 2, duration_seconds: 8.5 };
  try {
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/meetings/meeting/process-recording'));
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), manifest);
      return new Response(JSON.stringify({ detail: [{ loc: ['body'], msg: 'Field required' }] }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      });
    };
    await assert.rejects(api.processRecording('meeting', manifest), /неполные.*Обновите приложение/);
  } finally { globalThis.fetch = original; }
});
