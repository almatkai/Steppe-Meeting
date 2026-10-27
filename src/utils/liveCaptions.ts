export interface CaptionChunk { index: number; offset_seconds: number }
export interface CaptionResult { text: string; segments: unknown[]; model?: string }
export interface StreamingTranscript { session_id: string; chunk_count: number; duration_seconds: number }
export interface CaptionCallbacks {
  transcribe: (audio: Blob, signal: AbortSignal, chunk: CaptionChunk) => Promise<CaptionResult | string>;
  onText: (text: string) => void;
  onState: (state: "listening" | "recognizing" | "error", message?: string) => void;
  onLevel: (level: number) => void;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped * (clamped < 0 ? 32768 : 32767), true);
  });
  return new Blob([buffer], { type: "audio/wav" });
}

// Every sample belongs to one sequential chunk. A slow model accumulates a queue
// rather than dropping audio or resending overlapping windows.
export class CaptionBuffer {
  private frames: Float32Array[] = [];
  private count = 0;
  private silence = 0;
  private total = 0;
  private accepted = 0;
  private queue: { audio: Blob; chunk: CaptionChunk }[] = [];
  private running: Promise<void> | null = null;
  private request: AbortController | null = null;
  private stopped = false;
  private finishing = false;
  private retryAfter = 0;
  private rate: number;
  private callbacks: CaptionCallbacks;

  constructor(rate: number, callbacks: CaptionCallbacks) {
    this.rate = rate; this.callbacks = callbacks;
  }
  // Caption visibility must never determine what reaches the final transcript.
  setEnabled(_enabled: boolean) {}

  private enqueue() {
    if (!this.count) return;
    const samples = new Float32Array(this.count);
    let cursor = 0;
    for (const frame of this.frames) { samples.set(frame, cursor); cursor += frame.length; }
    const chunk = { index: this.accepted + this.queue.length, offset_seconds: (this.total - this.count) / this.rate };
    this.queue.push({ audio: encodeWav(samples, this.rate), chunk });
    this.frames = []; this.count = 0; this.silence = 0;
  }

  push(frame: Float32Array) {
    if (this.stopped || this.finishing) return;
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const rms = Math.sqrt(energy / Math.max(1, frame.length));
    this.callbacks.onLevel(Math.min(100, Math.round(rms * 500)));
    // Split oversized frames too, so request duration is always bounded.
    let cursor = 0;
    while (cursor < frame.length) {
      const length = Math.min(frame.length - cursor, this.rate * 8 - this.count);
      this.frames.push(frame.slice(cursor, cursor + length));
      this.count += length; this.total += length; cursor += length;
      this.silence = rms < 0.004 ? this.silence + length : 0;
      if (this.count >= this.rate * 8 || (this.count >= this.rate * 2 && this.silence >= this.rate * 0.35)) this.enqueue();
    }
    if (Date.now() >= this.retryAfter) void this.drain().catch(() => {});
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    if (!this.queue.length) return Promise.resolve();
    this.running = (async () => {
      while (this.queue.length && !this.stopped) {
        const pending = this.queue[0];
        this.request = new AbortController();
        this.callbacks.onState("recognizing");
        const result = await this.callbacks.transcribe(pending.audio, this.request.signal, pending.chunk);
        if (this.stopped) return;
        this.queue.shift(); this.accepted++;
        const text = typeof result === "string" ? result : result.text;
        if (text.trim()) this.callbacks.onText(text.trim());
      }
      if (!this.stopped) this.callbacks.onState("listening");
    })().catch((error: unknown) => {
      this.retryAfter = Date.now() + 2000;
      if (!this.stopped) this.callbacks.onState("error", error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { this.running = null; this.request = null; });
    return this.running;
  }

  async finish(): Promise<Omit<StreamingTranscript, "session_id">> {
    if (this.stopped) throw new Error("Потоковая запись отменена.");
    this.finishing = true;
    this.enqueue();
    await this.drain();
    return { chunk_count: this.accepted, duration_seconds: this.total / this.rate };
  }

  // Cancellation is reserved for disposal; normal Stop uses finish().
  stop() {
    this.stopped = true; this.request?.abort();
    this.frames = []; this.queue = []; this.count = 0;
  }
}

export async function startLiveCaptions(
  stream: MediaStream, callbacks: CaptionCallbacks, context = new AudioContext(),
) {
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(1024, 1, 1);
  const silent = context.createGain(); silent.gain.value = 0;
  const buffer = new CaptionBuffer(context.sampleRate, callbacks);
  processor.onaudioprocess = (event) => buffer.push(event.inputBuffer.getChannelData(0));
  source.connect(processor); processor.connect(silent); silent.connect(context.destination);
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true; processor.onaudioprocess = null;
    source.disconnect(); processor.disconnect(); silent.disconnect();
    if (context.state !== "closed") await context.close();
  };
  try { await context.resume(); }
  catch (error) { buffer.stop(); await detach(); throw error; }
  callbacks.onState("listening");
  return {
    setEnabled: (enabled: boolean) => buffer.setEnabled(enabled),
    finish: async () => { await detach(); return buffer.finish(); },
    stop: async () => { buffer.stop(); await detach(); },
  };
}

export async function startAudioLevelMonitor(
  stream: MediaStream,
  onLevel: (level: number) => void,
  context = new AudioContext(),
) {
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(1024, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const frame = event.inputBuffer.getChannelData(0);
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const rms = Math.sqrt(energy / Math.max(1, frame.length));
    onLevel(Math.min(100, Math.round(rms * 500)));
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    processor.onaudioprocess = null;
    try { source.disconnect(); } catch {}
    try { processor.disconnect(); } catch {}
    try { silent.disconnect(); } catch {}
    if (context.state !== "closed") await context.close().catch(() => {});
  };
  try {
    await context.resume();
  } catch (error) {
    await detach();
    throw error;
  }
  return {
    stop: async () => { await detach(); },
  };
}
