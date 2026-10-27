// Let WebKit use MP4/AAC instead of forcing WebM. The caller owns any
// recording session setup and cleanup.
export async function startMicrophoneRecording(
  onData: (chunk: Blob) => void,
  muted = false,
): Promise<{ stream: MediaStream; recorder: MediaRecorder }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Доступ к микрофону недоступен в этом окне.");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Запись аудио не поддерживается в этом окне.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
  });

  try {
    stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) onData(event.data);
    };
    recorder.start(300);
    return { stream, recorder };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

export function describeRecordingError(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "Нет доступа к микрофону. Разрешите Steppe Meeting в «Системные настройки → Конфиденциальность и безопасность → Микрофон». Если появится системный запрос, нажмите «Разрешить».";
  }
  if (error instanceof Error && error.name === "NotFoundError") {
    return "Микрофон не найден. Подключите микрофон или выберите устройство ввода в настройках звука.";
  }
  return error instanceof Error ? error.message : String(error);
}
