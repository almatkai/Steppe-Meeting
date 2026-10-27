import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishAudioFile } from '../src/utils/recordingFinalization.ts';
import { appendCaption, resetMiniRecording } from '../src/utils/miniRecording.ts';

const recorder = { state: 'inactive', mimeType: 'audio/webm' };
const input = () => ({ meetingId: 'meeting', sessionId: 'session', recorder, chunks: [new Blob(['audio'])] });

test('Reset stops captions and preserves audio before cancelling the stream, without generating', async () => {
  const events = [];
  let saved;
  await resetMiniRecording(input(), {
    finishAudio: finishAudioFile, cancelCaptions: async () => { events.push('cancel-captions'); },
    releaseMicrophone: () => { events.push('release-mic'); },
    retainFile: value => { saved = value; events.push('retain-file'); },
    uploadAudio: async (id, file) => { assert.equal(id, 'meeting'); assert.equal(await file.text(), 'audio'); events.push('upload'); },
    cancelSession: async (id, sessionId) => { assert.equal(sessionId, 'session'); events.push('cancel-session'); },
  });
  assert.deepEqual(events, ['cancel-captions', 'retain-file', 'release-mic', 'upload', 'cancel-session']);
  assert.equal(saved.uploaded, true);
});

test('Reset failure keeps the audio file for retry and does not duplicate its upload', async () => {
  let saved;
  let uploads = 0;
  const deps = {
    finishAudio: finishAudioFile, cancelCaptions: async () => {}, releaseMicrophone() {}, retainFile: value => { saved = value; },
    uploadAudio: async () => { uploads++; }, cancelSession: async () => { throw Error('offline'); },
  };
  await assert.rejects(resetMiniRecording(input(), deps), /offline/);
  assert.equal(await saved.file.text(), 'audio');
  await resetMiniRecording({ ...input(), saved }, { ...deps, cancelSession: async () => {} });
  assert.equal(uploads, 1);
});

test('Caption scrollback retains sequential phrases instead of replacing the previous text', () => {
  const first = appendCaption('', 'Первая фраза');
  assert.equal(appendCaption(first, 'Вторая фраза'), 'Первая фраза\nВторая фраза');
  assert.equal(appendCaption(first, ' '), first);
});
