import { test } from "node:test";
import assert from "node:assert/strict";
import { finishAudioFile, submitMiniRecording } from "../src/utils/recordingFinalization.ts";
import { CaptionBuffer, encodeWav } from "../src/utils/liveCaptions.ts";

test("stop waits for the final audio event, even later than the old 500ms delay", async () => {
  const chunks = [];
  class Recorder extends EventTarget {
    state = "recording";
    mimeType = "audio/mp4";
    stop() {
      this.state = "inactive";
      setTimeout(() => {
        chunks.push(new Blob(["final-audio"], { type: this.mimeType }));
        this.dispatchEvent(new Event("stop"));
      }, 550);
    }
  }
  const file = await finishAudioFile(new Recorder(), chunks);
  assert.equal(await file.text(), "final-audio");
  assert.ok(file.name.endsWith(".m4a"));
});

test("empty recording cannot be submitted", async () => {
  await assert.rejects(finishAudioFile({ state: "inactive", mimeType: "audio/mp4" }, []), /пуста/);
});

test("save -> server pipeline -> open the actual meeting in main", async () => {
  const events = [];
  const recording = { meetingId: "test-id", file: new File(["audio"], "test.m4a"), uploaded: false, transcript: { session_id: "stream", chunk_count: 1, duration_seconds: 8 } };
  await submitMiniRecording(recording, {
    uploadAudio: async () => { events.push("upload"); },
    processRecording: async () => { events.push("pipeline"); },
    openMeeting: async (id) => { assert.equal(id, "test-id"); events.push("open-main"); },
    onStage: () => {},
  });
  assert.deepEqual(events, ["upload", "pipeline", "open-main"]);
});

test("failed processing is surfaced; retry does not overwrite uploaded audio", async () => {
  const recording = { meetingId: "test-id", file: new File(["audio"], "test.m4a"), uploaded: false, transcript: { session_id: "stream", chunk_count: 1, duration_seconds: 8 } };
  let uploads = 0;
  let opened = false;
  const deps = {
    uploadAudio: async () => { uploads++; },
    processRecording: async () => { throw new Error("Backend unavailable"); },
    openMeeting: async () => { opened = true; }, onStage: () => {},
  };
  await assert.rejects(submitMiniRecording(recording, deps), /Backend unavailable/);
  assert.equal(opened, false);
  await submitMiniRecording(recording, { ...deps, processRecording: async () => {} });
  assert.equal(uploads, 1);
  assert.equal(opened, true);
});

test("heavy model or disabled captions: submitMiniRecording triggers offline transcribe + auto-generate", async () => {
  const events = [];
  const recording = { meetingId: "heavy-meeting-id", file: new File(["heavy-audio"], "test.m4a"), uploaded: false };
  await submitMiniRecording(recording, {
    uploadAudio: async () => { events.push("upload"); },
    transcribeMeeting: async (id, autoGen) => {
      assert.equal(id, "heavy-meeting-id");
      assert.equal(autoGen, true);
      events.push("transcribe-auto-gen");
    },
    openMeeting: async (id) => {
      assert.equal(id, "heavy-meeting-id");
      events.push("open-main");
    },
    onStage: (stage) => { events.push("stage:" + stage); },
  });
  assert.deepEqual(events, ["stage:saving", "upload", "stage:processing", "transcribe-auto-gen", "stage:opening", "open-main"]);
});

test("WAV encoder outputs independently decodable mono PCM, including sample rate", async () => {
  const audio = await encodeWav(new Float32Array([-1, 0, 1]), 48000).arrayBuffer();
  const view = new DataView(audio);
  assert.equal(new TextDecoder().decode(audio.slice(0, 4)), "RIFF");
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});

test("captions start during recording; one inference in flight and no stale updates after stop", async () => {
  let resolve;
  let requests = 0;
  const texts = [];
  const buffer = new CaptionBuffer(16000, {
    transcribe: async () => { requests++; return new Promise((done) => { resolve = done; }); },
    onText: (text) => texts.push(text), onLevel: () => {}, onState: () => {},
  });
  const speech = new Float32Array(128000).fill(0.1);
  buffer.push(speech);
  buffer.push(speech);
  assert.equal(requests, 1);
  resolve("Речь во время записи");
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(texts, ["Речь во время записи"]);
  assert.equal(requests, 2);
  buffer.push(speech); // third chunk queues behind the second
  assert.equal(requests, 2);
  buffer.stop();
  resolve("Поздний результат");
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(texts.length, 1);
});

test("hidden captions keep recognizing for the final transcript", async () => {
  let requests = 0;
  const buffer = new CaptionBuffer(16000, {
    transcribe: async () => { requests++; return ""; },
    onText: () => {}, onState: () => {}, onLevel: () => {},
  });
  buffer.setEnabled(false);
  buffer.push(new Float32Array(128000).fill(0.1));
  await buffer.finish();
  assert.equal(requests, 1);
});

test("retrying a failed window restore never repeats accepted offline transcription", async () => {
  const recording = { meetingId: "offline", file: new File(["audio"], "audio.m4a"), uploaded: false };
  let uploads = 0;
  let transcriptions = 0;
  let opens = 0;
  const deps = {
    uploadAudio: async () => { uploads++; },
    transcribeMeeting: async () => { transcriptions++; },
    openMeeting: async () => { if (++opens === 1) throw new Error("Window restore failed"); },
    onStage: () => {},
  };
  await assert.rejects(submitMiniRecording(recording, deps), /Window restore failed/);
  await submitMiniRecording(recording, deps);
  assert.equal(uploads, 1);
  assert.equal(transcriptions, 1);
  assert.equal(opens, 2);
});
