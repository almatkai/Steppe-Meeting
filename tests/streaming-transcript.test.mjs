import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionBuffer } from '../src/utils/liveCaptions.ts';
import { submitMiniRecording } from '../src/utils/recordingFinalization.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const callbacks = transcribe => ({ transcribe, onText() {}, onState() {}, onLevel() {} });

test('Stop retains in-flight recognition and flushes the unsent tail exactly once', async () => {
  const requests = [];
  let resolveFirst;
  const buffer = new CaptionBuffer(16000, callbacks(async (audio, signal, chunk) => {
    requests.push({ samples: (await audio.arrayBuffer()).byteLength / 2 - 22, signal, chunk });
    if (requests.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return { text: 'хвост', segments: [] };
  }));
  buffer.push(new Float32Array(128000).fill(0.1));
  await tick();
  buffer.push(new Float32Array(8000).fill(0.1));
  const finishing = buffer.finish();
  resolveFirst({ text: 'первая часть', segments: [] });
  const result = await finishing;
  assert.equal(result.chunk_count, 2);
  assert.equal(result.duration_seconds, 8.5);
  assert.deepEqual(requests.map(request => request.samples), [128000, 8000]);
  assert.deepEqual(requests.map(request => request.chunk.index), [0, 1]);
  assert.deepEqual(requests.map(request => request.chunk.offset_seconds), [0, 8]);
  assert.ok(requests.every(request => !request.signal.aborted));
});

test('Hiding captions never disables transcription of the recording', async () => {
  let requests = 0;
  const buffer = new CaptionBuffer(16000, callbacks(async () => { requests++; return { text: 'речь', segments: [] }; }));
  buffer.setEnabled(false);
  buffer.push(new Float32Array(128000).fill(0.1));
  await tick();
  await buffer.finish();
  assert.equal(requests, 1);
});

test('Mini completion submits the streaming transcript reference rather than requesting full-file STT', async () => {
  const transcript = { session_id: 'stream-1', chunk_count: 2, duration_seconds: 8.5 };
  const saved = { meetingId: 'meeting-1', file: new File(['audio'], 'test.m4a'), uploaded: false, transcript };
  const events = [];
  await submitMiniRecording(saved, {
    uploadAudio: async () => { events.push('upload'); },
    processRecording: async (id, payload) => { assert.equal(id, 'meeting-1'); assert.deepEqual(payload, transcript); events.push('generate-from-stream'); },
    openMeeting: async () => { events.push('open'); }, onStage() {},
  });
  assert.deepEqual(events, ['upload', 'generate-from-stream', 'open']);
});


test('A failed head chunk is retried unchanged before the queued tail', async () => {
  const calls = [];
  let fail = true;
  const buffer = new CaptionBuffer(16000, callbacks(async (audio, signal, chunk) => {
    calls.push({ audio, ...chunk });
    if (fail) { fail = false; throw new Error('network'); }
    return { text: 'речь', segments: [] };
  }));
  buffer.push(new Float32Array(128000).fill(0.1));
  await tick();
  buffer.push(new Float32Array(8000).fill(0.1));
  const result = await buffer.finish();
  assert.deepEqual(calls.map(call => call.index), [0, 0, 1]);
  assert.equal(calls[0].audio, calls[1].audio);
  assert.equal(result.duration_seconds, 8.5);
  assert.equal(result.chunk_count, 2);
});

test('A speech pause submits a short phrase without waiting for the maximum window', async () => {
  const calls = [];
  const buffer = new CaptionBuffer(16000, callbacks(async (audio, signal, chunk) => {
    calls.push({ audio, ...chunk }); return { text: 'фраза', segments: [] };
  }));
  buffer.push(new Float32Array(32000).fill(0.1));
  buffer.push(new Float32Array(6400));
  await tick();
  assert.equal(calls.length, 1);
  const result = await buffer.finish();
  assert.equal(result.duration_seconds, 2.4);
  assert.equal(result.chunk_count, 1);
});
