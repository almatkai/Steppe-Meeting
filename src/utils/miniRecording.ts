import type { finishAudioFile, SavedRecording } from "./recordingFinalization";

// Reset cancels live inference immediately, while retaining a recoverable audio
// draft. Starting a new session is allowed only after that backup is saved.
export async function resetMiniRecording(
  recording: { meetingId: string; sessionId: string; recorder: MediaRecorder; chunks: Blob[]; saved?: SavedRecording | null },
  dependencies: {
    finishAudio: typeof finishAudioFile;
    cancelCaptions: () => Promise<void>;
    releaseMicrophone: () => void;
    retainFile: (saved: SavedRecording) => void;
    uploadAudio: (id: string, file: File) => Promise<unknown>;
    cancelSession: (id: string, sessionId: string) => Promise<unknown>;
    releaseCapture?: () => void;
  },
) {
  await dependencies.cancelCaptions();
  let saved = recording.saved;
  try {
    if (!saved) {
      saved = { meetingId: recording.meetingId, file: await dependencies.finishAudio(recording.recorder, recording.chunks), uploaded: false };
      dependencies.retainFile(saved);
    }
  } finally { dependencies.releaseMicrophone(); }
  if (!saved.uploaded) {
    await dependencies.uploadAudio(saved.meetingId, saved.file);
    saved.uploaded = true;
  }
  await dependencies.cancelSession(saved.meetingId, recording.sessionId);
  dependencies.releaseCapture?.();
}

export function appendCaption(previous: string, text: string): string {
  if (!text.trim()) return previous;
  // Only the UI scrollback is bounded; the server journal holds the full text.
  return [previous, text.trim()].filter(Boolean).join("\n").slice(-20000);
}
