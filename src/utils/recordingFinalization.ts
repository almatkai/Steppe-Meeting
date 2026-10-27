import type { StreamingTranscript } from "./liveCaptions";

export interface SavedRecording {
  meetingId: string;
  file: File;
  uploaded: boolean;
  processed?: boolean;
  transcript?: StreamingTranscript;
}

export async function finishAudioFile(recorder: MediaRecorder, chunks: Blob[]): Promise<File> {
  if (recorder.state !== "inactive") {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        recorder.removeEventListener("stop", stopped);
        recorder.removeEventListener("error", failed);
      };
      const stopped = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Ошибка завершения аудиозаписи.")); };
      const timeout = setTimeout(() => {
        cleanup(); reject(new Error("Аудиозапись не завершилась. Попробуйте сохранить повторно."));
      }, 10000);
      recorder.addEventListener("stop", stopped, { once: true });
      recorder.addEventListener("error", failed, { once: true });
      try { recorder.stop(); } catch (error) { cleanup(); reject(error); }
    });
  }
  // The final dataavailable event occurs before stop; never guess with a 500ms delay.
  const type = recorder.mimeType || chunks.find((chunk) => chunk.type)?.type || "audio/mp4";
  const audio = new Blob(chunks, { type });
  if (!audio.size) throw new Error("Запись пуста. Проверьте микрофон и попробуйте снова.");
  const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  return new File([audio], `meeting_mini_${Date.now()}.${extension}`, { type });
}

export async function submitMiniRecording(
  recording: SavedRecording,
  dependencies: {
    uploadAudio: (id: string, file: File) => Promise<unknown>;
    processRecording?: (id: string, transcript: StreamingTranscript) => Promise<unknown>;
    transcribeMeeting?: (id: string, autoGenerate?: boolean) => Promise<unknown>;
    openMeeting: (id: string) => Promise<void>;
    onStage: (stage: "saving" | "processing" | "opening") => void;
  },
): Promise<void> {
  if (!recording.uploaded) {
    dependencies.onStage("saving");
    await dependencies.uploadAudio(recording.meetingId, recording.file);
    recording.uploaded = true;
  }
  if (!recording.processed) {
    dependencies.onStage("processing");
    if (recording.transcript && dependencies.processRecording) {
      // Fast path: backend generates from streaming chunks without re-transcribing.
      await dependencies.processRecording(recording.meetingId, recording.transcript);
    } else if (dependencies.transcribeMeeting) {
      // Offline path: heavy models (>200MB) or user disabled captions.
      await dependencies.transcribeMeeting(recording.meetingId, true);
    } else if (!recording.transcript) {
      throw new Error("Потоковый транскрипт ещё не завершён. Повторите сохранение.");
    } else {
      throw new Error("Не удалось запустить обработку записи.");
    }
    recording.processed = true;
  }
  dependencies.onStage("opening");
  await dependencies.openMeeting(recording.meetingId);
}
