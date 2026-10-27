// No real microphone is accessed: test the actual capture helper with platform fakes.
// Run: node --test tests/microphone-recording.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMicrophoneRecording, describeRecordingError } from "../src/utils/microphoneRecording.ts";

test("permission denied rejects without starting a recorder", async () => {
  let constructed = false;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: async () => { throw new DOMException("Denied", "NotAllowedError"); },
  } });
  globalThis.MediaRecorder = class { constructor() { constructed = true; } };
  await assert.rejects(startMicrophoneRecording(() => {}), { name: "NotAllowedError" });
  assert.equal(constructed, false);
  assert.match(describeRecordingError(new DOMException("Denied", "NotAllowedError")), /Микрофон/);
});

test("Safari MP4 support, initial mute, and final data delivery", async () => {
  const track = { enabled: true, stop() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  navigator.mediaDevices.getUserMedia = async () => stream;
  globalThis.MediaRecorder = class {
    static isTypeSupported(type) { return type === "audio/mp4"; }
    constructor(actual, options) {
      assert.equal(actual, stream);
      assert.equal(options.mimeType, "audio/mp4");
      this.mimeType = options.mimeType;
    }
    start(interval) { assert.equal(interval, 300); }
  };
  const chunks = [];
  const result = await startMicrophoneRecording((chunk) => chunks.push(chunk), true);
  assert.equal(track.enabled, false);
  const chunk = new Blob(["test"], { type: "audio/mp4" });
  result.recorder.ondataavailable({ data: chunk });
  assert.deepEqual(chunks, [chunk]);
});

test("recorder startup failure releases the microphone", async () => {
  let stopped = false;
  const track = { enabled: true, stop() { stopped = true; } };
  navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [track], getTracks: () => [track] });
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return false; }
    constructor(_, options) { assert.equal(options, undefined); }
    start() { throw new Error("Cannot start"); }
  };
  await assert.rejects(startMicrophoneRecording(() => {}), /Cannot start/);
  assert.equal(stopped, true);
});
