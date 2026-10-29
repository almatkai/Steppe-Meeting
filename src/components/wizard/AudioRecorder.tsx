import { acquireUpdateCapture } from "../../utils/updateCapture";
import { assertUpdateNotInstalling } from "../../services/api";
import React, { useEffect, useRef, useState } from "react";
import { ConfirmDeleteDialog } from "../ui/ConfirmDeleteDialog";
import {
  Microphone as Mic,
  MicrophoneSlash as MicOff,
  SpeakerHigh as Volume2,
  SpeakerSlash as VolumeX,
  Square,
  Trash as Trash2,
  CheckCircle as CheckCircle2,
  Info,
  SlidersHorizontal as Sliders,
  Warning as AlertTriangle,
  Lightning as Zap,
} from "@phosphor-icons/react";

interface AudioRecorderProps {
  onAudioReady: (file: File | null, lease?: () => Promise<void>) => void;
}

const checkIsTauri = () => {
  return (
    typeof window !== "undefined" &&
    (Boolean((window as any).isTauri) ||
      Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI__))
  );
};

export const AudioRecorder: React.FC<AudioRecorderProps> = ({ onAudioReady }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isNativeRecording, setIsNativeRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string>("");
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");

  const isTauri = checkIsTauri();

  // Source selection states
  const [includeMic, setIncludeMic] = useState(true);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [hasSystemAudioPermission, setHasSystemAudioPermission] = useState<boolean | null>(null);
  const [activeSources, setActiveSources] = useState<{ mic: boolean; system: boolean }>({
    mic: true,
    system: false,
  });

  useEffect(() => {
    if (isTauri) {
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke<boolean>("check_screen_capture_permission")
          .then((hasPerm) => {
            setHasSystemAudioPermission(hasPerm);
            if (hasPerm) {
              setIncludeSystem(true);
              setActiveSources({ mic: true, system: true });
            } else {
              setIncludeSystem(false);
              setActiveSources({ mic: true, system: false });
            }
          })
          .catch(() => {});
      });
    }
  }, [isTauri]);

  const releaseUpdateCapture = useRef<(() => Promise<void>) | null>(null);
  const releaseCapture = () => { startingCapture.current = false; const release = releaseUpdateCapture.current; releaseUpdateCapture.current = null; void release?.().catch(console.error); };
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<any>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const awaitingWebStop = useRef(false);
  const awaitingNativeStop = useRef(false);
  const nativeActive = useRef(false);
  const startingCapture = useRef(false);
  const mounted = useRef(true);
  const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const prevBarsRef = useRef<number[]>(new Array(52).fill(6));

  // Cleanup on unmount
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (nativeActive.current) void stopRecordingRef.current?.();
      clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (displayStreamRef.current) {
        displayStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
      // Web onstop owns final chunks and transfers its lease to the file owner.
      if (!awaitingWebStop.current && !awaitingNativeStop.current && !startingCapture.current) releaseCapture();
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, []);

  // Helper to draw rounded rectangle on canvas
  const drawRoundedBar = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
  ) => {
    const r = Math.min(radius, width / 2, Math.max(1, height / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, width, height, r);
    } else {
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
    }
    ctx.fill();
  };

  // Continuous animation loop for visualizer
  useEffect(() => {
    let animationId: number;

    const render = (time: number) => {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.max(300, Math.floor(rect.width * dpr));
        const targetH = Math.max(80, Math.floor(rect.height * dpr));

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext("2d");
        if (ctx) {
          const width = canvas.width;
          const height = canvas.height;
          const centerY = height / 2;
          const numBars = 52;
          const barWidth = Math.max(3.5, (width / numBars) * 0.58);
          const spacing = (width - numBars * barWidth) / (numBars + 1);

          // Clear background
          ctx.clearRect(0, 0, width, height);
          ctx.fillStyle = "#0a0a0a";
          ctx.fillRect(0, 0, width, height);

          // State 1: Active Live Recording
          if (isRecording) {
            let dataArray: Uint8Array | null = null;
            let bufferLength = 0;

            if (analyserRef.current) {
              const analyser = analyserRef.current;
              bufferLength = analyser.frequencyBinCount;
              dataArray = new Uint8Array(bufferLength);
              analyser.getByteFrequencyData(dataArray as any);
            }

            const maxBarHeight = height * 0.85;

            for (let i = 0; i < numBars; i++) {
              const x = spacing + i * (barWidth + spacing);

              let rawVal = 0;
              if (dataArray && bufferLength > 0) {
                const bin = Math.min(
                  bufferLength - 1,
                  Math.floor(Math.pow((i + 1) / numBars, 1.25) * 44) + 2
                );
                rawVal = dataArray[bin] || 0;
              } else {
                // Synthesize live activity wave for native mode
                const pulse = Math.sin(time * 0.008 + i * 0.28) * 0.5 + 0.5;
                const wave2 = Math.cos(time * 0.005 + i * 0.15) * 0.5 + 0.5;
                rawVal = (pulse * 0.6 + wave2 * 0.4) * 140;
              }

              const idleRipple = (Math.sin(time * 0.005 + i * 0.35) * 0.5 + 0.5) * 6 + 4;
              const targetHeight = Math.max(idleRipple, (rawVal / 255) * maxBarHeight);

              const prev = prevBarsRef.current[i] || 4;
              const smoothed = targetHeight > prev ? targetHeight : prev * 0.85 + targetHeight * 0.15;
              prevBarsRef.current[i] = smoothed;

              const y = centerY - smoothed / 2;

              ctx.save();
              if (rawVal > 35) {
                ctx.shadowBlur = 12;
                ctx.shadowColor = "rgba(99, 102, 241, 0.6)";
              }
              ctx.fillStyle = "#d4d4d4";
              drawRoundedBar(ctx, x, y, barWidth, smoothed, 3);
              ctx.restore();
            }
          }
          // State 2: Recorded audio ready
          else if (recordedFile) {
            for (let i = 0; i < numBars; i++) {
              const x = spacing + i * (barWidth + spacing);
              const pseudo = Math.abs(Math.sin(i * 0.38) * Math.cos(i * 0.22 + 0.4));
              const barHeight = Math.max(8, pseudo * height * 0.68);
              const y = centerY - barHeight / 2;

              ctx.fillStyle = "#10b981";
              drawRoundedBar(ctx, x, y, barWidth, barHeight, 3);
            }
          }
          // State 3: Idle (before recording)
          else {
            for (let i = 0; i < numBars; i++) {
              const x = spacing + i * (barWidth + spacing);
              const wave = Math.sin(time * 0.003 + i * 0.22) * 5 + 6;
              const y = centerY - wave / 2;

              ctx.fillStyle = "rgba(99, 102, 241, 0.22)";
              drawRoundedBar(ctx, x, y, barWidth, wave, 2);
            }
          }
        }
      }

      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [isRecording, !!recordedFile]);

  const getSupportedMimeType = () => {
    const isSafari =
      typeof navigator !== "undefined" &&
      /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const types = isSafari
      ? [
          "audio/mp4",
          "audio/aac",
          "audio/wav",
          "audio/webm;codecs=opus",
          "audio/webm",
        ]
      : [
          "audio/webm;codecs=opus",
          "audio/mp4",
          "audio/webm",
          "audio/ogg;codecs=opus",
          "audio/wav",
        ];

    const testAudio = typeof Audio !== "undefined" ? document.createElement("audio") : null;
    for (const t of types) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
        if (testAudio) {
          const canPlay = testAudio.canPlayType(t);
          if (canPlay === "probably" || canPlay === "maybe") {
            return t;
          }
        } else {
          return t;
        }
      }
    }
    return "";
  };

  const startRecording = async () => {
    try { assertUpdateNotInstalling(); } catch (error) { setError((error as Error).message); return; }
    setError("");
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl("");
    }
    setRecordedFile(null);
    setDuration(0);

    if (!includeMic && !includeSystem) {
      setError("Пожалуйста, выберите хотя бы один источник звука: микрофон или системный звук.");
      return;
    }

    startingCapture.current = true;
    try { releaseUpdateCapture.current = await acquireUpdateCapture(); }
    catch { startingCapture.current = false; setError('Устанавливаем обновление. Дождитесь перезапуска приложения.'); return; }
    if (!mounted.current) { startingCapture.current = false; releaseCapture(); return; }
    // -------------------------------------------------------------
    // OPTION A: NATIVE TAURI ScreenCaptureKit (Only when system audio is selected)
    // -------------------------------------------------------------
    const isRunningInTauri = isTauri || checkIsTauri();
    if (isRunningInTauri && includeSystem) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const hasPerm = await invoke<boolean>("check_screen_capture_permission");
        if (!hasPerm) {
          throw new Error("PermissionNotGranted");
        }
        if (!mounted.current) { releaseCapture(); return; }
        await invoke<string>("start_native_recording", {
          recordMic: includeMic,
        });

        if (!mounted.current) {
          await invoke("stop_native_recording");
          releaseCapture(); return;
        }
        nativeActive.current = true;
        startingCapture.current = false;
        setIsNativeRecording(true);
        setIsRecording(true);
        setRecordingTime(0);
        setActiveSources({ mic: includeMic, system: true });

        timerRef.current = setInterval(() => {
          setRecordingTime((prev) => prev + 1);
        }, 1000);
        return;
      } catch (nativeErr: any) {
        if (!mounted.current) { releaseCapture(); return; }
        console.warn("Native system recording unavailable, falling back to microphone:", nativeErr);
        if (includeMic) {
          setError(
            "Системный звук не включен в настройках macOS. Запись запущена через ваш микрофон (голос)."
          );
          // Do NOT return: continue directly to microphone recording below so user is not blocked!
        } else {
          setError(
            "Для записи звука системы включите тумблер Steppe Meeting в «Системные настройки» -> «Конфиденциальность и безопасность» -> «Запись экрана и системного звука» и подтвердите «Завершить и перезапустить»."
          );
          releaseCapture();
          return;
        }
      }
    }

    // -------------------------------------------------------------
    // OPTION B: Web fallback / Microphone-only recording
    // -------------------------------------------------------------
    let micStream: MediaStream | null = null;
    let displayStream: MediaStream | null = null;
    let micConnected = false;
    let systemConnected = false;

    try {
      if (includeSystem && !isRunningInTauri) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          throw new Error(
            "Захват системного звука не поддерживается в текущем браузере. Запустите нативное приложение Steppe Meeting."
          );
        }

        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
            systemAudio: "include",
          } as any);

          const audioTracks = displayStream.getAudioTracks();
          const videoTrack = displayStream.getVideoTracks()[0];
          const surface = videoTrack?.getSettings()?.displaySurface;

          if (audioTracks.length > 0) {
            systemConnected = true;
            displayStreamRef.current = displayStream;

            displayStream.getVideoTracks().forEach((vt) => {
              vt.enabled = false;
              vt.onended = () => {
                if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                  stopRecording();
                }
              };
            });
          } else {
            displayStream.getTracks().forEach((t) => t.stop());
            displayStream = null;

            if (surface === "window") {
              setError(
                "На macOS захват звука из отдельного окна заблокирован операционной системой. Нажмите в верхней панели синюю кнопку «Поделиться всем экраном»."
              );
            } else {
              setError(
                "Аудиодорожка системы не была передана. В верхней панели нажмите синюю кнопку «Поделиться всем экраном»."
              );
            }
            releaseCapture();
            return;
          }
        } catch (displayErr: any) {
          if (displayErr.name === "NotAllowedError" || displayErr.name === "AbortError") {
            setError(
              "Выбор был отменен. Чтобы записать звук системы, в верхней панели нажмите «Поделиться всем экраном»."
            );
            releaseCapture();
            return;
          } else {
            throw displayErr;
          }
        }
      }

      if (includeMic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: true,
            },
          });
          micStreamRef.current = micStream;
          micConnected = true;
        } catch (micErr: any) {
          if (displayStream) {
            displayStream.getTracks().forEach((t) => t.stop());
            displayStreamRef.current = null;
          }
          throw new Error("Не удалось получить доступ к микрофону: " + (micErr.message || String(micErr)));
        }
      }

      if (!mounted.current) {
        micStream?.getTracks().forEach(track => track.stop());
        displayStream?.getTracks().forEach(track => track.stop());
        releaseCapture(); return;
      }
      if (!micConnected && !systemConnected) {
        setError("Не удалось подключить ни один источник звука.");
        releaseCapture();
        return;
      }

      if (audioContextRef.current) {
        try {
          await audioContextRef.current.close();
        } catch (_) {}
        audioContextRef.current = null;
      }
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }

      const destination = audioCtx.createMediaStreamDestination();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      analyserRef.current = analyser;

      if (micStream && micStream.getAudioTracks().length > 0) {
        const micSource = audioCtx.createMediaStreamSource(micStream);
        const micGain = audioCtx.createGain();
        micGain.gain.value = 1.8; // Software boost for clear, loud voice
        micSource.connect(micGain);
        micGain.connect(destination);
        micGain.connect(analyser);
      }

      if (displayStream && displayStream.getAudioTracks().length > 0) {
        const sysSource = audioCtx.createMediaStreamSource(displayStream);
        const sysGain = audioCtx.createGain();
        sysGain.gain.value = 1.0;
        sysSource.connect(sysGain);
        sysGain.connect(destination);
        sysGain.connect(analyser);
      }

      setActiveSources({ mic: micConnected, system: systemConnected });

      const mixedStream = destination.stream;
      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : undefined;
      const mediaRecorder = new MediaRecorder(mixedStream, options);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      awaitingWebStop.current = true;
      mediaRecorder.onstop = () => {
        const actualType = mediaRecorder.mimeType || mimeType || "audio/mp4";
        const extension =
          actualType.includes("mp4") || actualType.includes("m4a") || actualType.includes("aac")
            ? "m4a"
            : actualType.includes("ogg")
            ? "ogg"
            : actualType.includes("wav")
            ? "wav"
            : "webm";

        const blob = new Blob(chunksRef.current, { type: actualType });
        if (blob.size > 0) {
          const file = new File(
            [blob],
            `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
            { type: actualType }
          );
          setRecordedFile(file);
          const lease = releaseUpdateCapture.current;
          releaseUpdateCapture.current = null;
          onAudioReady(file, lease || undefined);

          const url = URL.createObjectURL(blob);
          setAudioUrl(url);
        }

        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach((track) => track.stop());
          micStreamRef.current = null;
        }
        if (displayStreamRef.current) {
          displayStreamRef.current.getTracks().forEach((track) => track.stop());
          displayStreamRef.current = null;
        }
        awaitingWebStop.current = false;
        releaseCapture();
      };

      if (!mounted.current) {
        awaitingWebStop.current = false;
        micStream?.getTracks().forEach(track => track.stop());
        displayStream?.getTracks().forEach(track => track.stop());
        void audioCtx.close().catch(() => {});
        releaseCapture(); return;
      }
      mediaRecorder.start(250);
      startingCapture.current = false;
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      awaitingWebStop.current = false;
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
      if (displayStreamRef.current) {
        displayStreamRef.current.getTracks().forEach((t) => t.stop());
        displayStreamRef.current = null;
      }
      releaseCapture();
      setError("Ошибка при запуске записи: " + (err.message || String(err)));
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;

    // Stop native recording
    if (isNativeRecording) {
      if (awaitingNativeStop.current) return;
      awaitingNativeStop.current = true;
      try {
        setIsRecording(false);
        clearInterval(timerRef.current);

        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach((t) => t.stop());
          micStreamRef.current = null;
        }
        if (audioContextRef.current) {
          audioContextRef.current.close().catch(() => {});
          audioContextRef.current = null;
        }

        const { invoke } = await import("@tauri-apps/api/core");
        const recordedPath = await invoke<string>("stop_native_recording");
        const fileBytes = await invoke<any>("read_recording_file", { path: recordedPath });
        const uint8Array = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
        const blob = new Blob([uint8Array], { type: "video/mp4" });
        const file = new File(
          [blob],
          `meeting_${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`,
          { type: "video/mp4" }
        );

        setRecordedFile(file);
        const lease = releaseUpdateCapture.current;
        releaseUpdateCapture.current = null;
        onAudioReady(file, lease || undefined);

        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setIsNativeRecording(false);
      } catch (err: any) {
        console.error("Stop native recording error:", err);
        setError("Ошибка остановки нативной записи: " + (err.message || String(err)));
        setIsNativeRecording(false);
      }
      nativeActive.current = false;
      awaitingNativeStop.current = false;
      releaseCapture();
      return;
    }

    // Stop web recording
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  stopRecordingRef.current = stopRecording;

  const discardRecording = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl("");
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setRecordedFile(null);
    setRecordingTime(0);
    setDuration(0);
    setError("");
    onAudioReady(null);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="rounded-2xl border border-neutral-700/80 bg-neutral-900/50 p-6 space-y-4">
      <ConfirmDeleteDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}
        title="Удалить запись?" confirmLabel="Удалить запись"
        description={`Запись длительностью ${formatTime(duration || recordingTime)} будет удалена без возможности восстановления. После удаления можно записать заново.`}
        onConfirm={discardRecording} />
      {error && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1 leading-relaxed">
            <div>{error}</div>
            {error.includes("системн") && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIncludeSystem(false);
                    setIncludeMic(true);
                    setError("");
                  }}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 text-xs font-medium cursor-pointer transition-colors flex items-center gap-1.5"
                >
                  <Mic className="w-3.5 h-3.5 text-rose-300" />
                  Записать только голос
                </button>
                {(isTauri || checkIsTauri()) && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const { invoke } = await import("@tauri-apps/api/core");
                        await invoke("open_screen_recording_settings");
                      } catch (_) {}
                    }}
                    className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium cursor-pointer transition-colors flex items-center gap-1.5"
                  >
                    ⚙️ Настройки записи звука Mac
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setError("")}
            className="text-rose-400 hover:text-rose-200 text-xs font-semibold px-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Audio Source Selector Toggles (Mic + System Sound) */}
      {!isRecording && !recordedFile && (
        <div className="space-y-2.5">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-xl bg-neutral-950/70 border border-neutral-800">
            <div className="text-xs text-neutral-300 font-medium flex items-center gap-2">
              <Sliders className="w-4 h-4 text-neutral-400" />
              <span>Источники аудио:</span>
            </div>

            <div className="flex items-center gap-2">
              {/* Mic Toggle */}
              <button
                type="button"
                onClick={() => {
                  if (includeMic && !includeSystem) return;
                  setIncludeMic(!includeMic);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
                  includeMic
                    ? "bg-neutral-800/70 text-neutral-200 border-neutral-700 shadow-sm"
                    : "bg-neutral-900/60 text-neutral-500 border-neutral-800 hover:text-neutral-400"
                }`}
                title="Записывать ваш голос через микрофон"
              >
                {includeMic ? <Mic className="w-3.5 h-3.5 text-neutral-400" /> : <MicOff className="w-3.5 h-3.5" />}
                <span>Микрофон</span>
                {includeMic && <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 ml-0.5" />}
              </button>

              {/* System Sound Toggle */}
              <button
                type="button"
                onClick={async () => {
                  if (includeSystem && !includeMic) return;
                  if (!includeSystem) {
                    if (isTauri) {
                      try {
                        const { invoke } = await import("@tauri-apps/api/core");
                        const hasPerm = await invoke<boolean>("check_screen_capture_permission");
                        setHasSystemAudioPermission(hasPerm);
                        if (!hasPerm) {
                          await invoke("request_screen_capture_permission");
                        }
                      } catch (_) {}
                    }
                    setIncludeSystem(true);
                  } else {
                    setIncludeSystem(false);
                    setIncludeMic(true);
                    setError("");
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
                  includeSystem
                    ? "bg-neutral-800/70 text-neutral-200 border-neutral-700 shadow-sm"
                    : "bg-neutral-900/60 text-neutral-500 border-neutral-800 hover:text-neutral-400"
                }`}
                title="Записывать системный звук (собеседников в Zoom, Meet, Teams, звонках или видео)"
              >
                {includeSystem ? (
                  <Volume2 className="w-3.5 h-3.5 text-neutral-400" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
                <span>Звук системы</span>
                {includeSystem && <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 ml-0.5" />}
              </button>
            </div>
          </div>

          {/* Guidance Info Banner */}
          {includeSystem && (
            <div className="p-3 rounded-xl bg-neutral-900/60 border border-neutral-800 text-xs text-neutral-300 flex items-start gap-2.5 leading-relaxed">
              <Info className="w-4 h-4 text-neutral-400 shrink-0 mt-0.5" />
              <span>
                {(isTauri || checkIsTauri()) ? (
                  <>
                    <strong>Нативный режим macOS (Rust):</strong> захват звука системы и микрофона выполняется напрямую через Apple ScreenCaptureKit без диалогов шеринга экрана.
                  </>
                ) : (
                  <>
                    <strong>Внимание:</strong> открыто в браузере. Для записи системного звука без диалогов шеринга экрана используйте настольное приложение <strong>Steppe Meeting</strong>.
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col items-center justify-center">
        {/* Dynamic Waveform Visualizer Canvas */}
        <div className="w-full h-28 mb-4 rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-950 relative flex items-center justify-center shadow-inner">
          <canvas ref={canvasRef} className="w-full h-full block" />

          {/* Status Overlay Badges */}
          {isRecording && (
            <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-medium backdrop-blur-md animate-pulse">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
              <span>
                Запись:{" "}
                {activeSources.mic && activeSources.system
                  ? "Микрофон + Звук системы"
                  : activeSources.system
                  ? "Звук системы"
                  : "Микрофон"}
                {isNativeRecording ? " (Native Rust)" : ""}
              </span>
            </div>
          )}

          {!isRecording && !recordedFile && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 text-neutral-400 text-xs font-medium backdrop-blur-sm shadow-sm">
                {includeSystem && includeMic ? (
                  <Volume2 className="w-3.5 h-3.5 text-neutral-400" />
                ) : includeSystem ? (
                  <Volume2 className="w-3.5 h-3.5 text-neutral-400" />
                ) : (
                  <Mic className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span>
                  {includeMic && includeSystem
                    ? "Микрофон и звук системы готовы • Нажмите «Начать запись»"
                    : includeSystem
                    ? "Звук системы готов • Нажмите «Начать запись»"
                    : "Микрофон готов • Нажмите «Начать запись»"}
                </span>
              </div>
            </div>
          )}

          {recordedFile && !isRecording && (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium backdrop-blur-md">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                Аудиодорожка записана (
                {activeSources.mic && activeSources.system
                  ? "Микрофон + Система"
                  : activeSources.system
                  ? "Звук системы"
                  : "Микрофон"}
                )
              </span>
            </div>
          )}
        </div>

        {/* Timer display */}
        <div className="font-mono text-3xl font-bold text-white mb-4 tracking-tight">
          {isRecording
            ? formatTime(recordingTime)
            : recordedFile
            ? formatTime(duration || recordingTime)
            : "00:00"}
        </div>

        {/* Action Controls */}
        <div className="flex flex-col items-center gap-3 w-full">
          {!isRecording && !recordedFile && (
            <button
              type="button"
              onClick={startRecording}
              className="flex items-center gap-2.5 py-3 px-8 rounded-xl bg-white hover:bg-neutral-300 text-neutral-950 font-medium text-sm transition-all active:scale-95 cursor-pointer"
            >
              {includeSystem && includeMic ? (
                <Volume2 className="w-4 h-4" />
              ) : includeSystem ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
              <span>
                {includeSystem && includeMic
                  ? "Начать запись встречи (микрофон + система)"
                  : includeSystem
                  ? "Начать запись звука системы"
                  : "Начать запись с микрофона"}
              </span>
            </button>
          )}

          {isRecording && (
            <button
              type="button"
              onClick={stopRecording}
              className="flex items-center gap-2.5 py-3 px-8 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-medium text-sm transition-all shadow-lg shadow-rose-600/30 active:scale-95 cursor-pointer animate-pulse"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>Остановить запись</span>
            </button>
          )}

          {recordedFile && !isRecording && (
            <div className="flex flex-col items-center gap-3 w-full max-w-lg">
              {/* Audio Player Card */}
              <div className="w-full p-4 rounded-xl bg-neutral-950/80 border border-neutral-800 flex flex-col gap-3 shadow-inner">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-emerald-400 font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Запись сохранена ({formatTime(duration || recordingTime)})</span>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 font-normal">
                      {activeSources.mic && activeSources.system
                        ? "Микрофон + Система"
                        : activeSources.system
                        ? "Звук системы"
                        : "Микрофон"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10 text-xs transition-colors cursor-pointer"
                    title="Удалить запись"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Удалить и записать заново</span>
                  </button>
                </div>

                {/* Native HTML5 Audio/Video Player */}
                {audioUrl && (
                  <audio
                    ref={audioPlayerRef}
                    src={audioUrl}
                    controls
                    preload="auto"
                    className="w-full h-11 rounded-lg accent-neutral-200 bg-neutral-900 border border-neutral-800"
                    onLoadedMetadata={(e) => {
                      if (
                        e.currentTarget.duration &&
                        !isNaN(e.currentTarget.duration) &&
                        isFinite(e.currentTarget.duration)
                      ) {
                        setDuration(e.currentTarget.duration);
                      }
                    }}
                  />
                )}

                <div className="flex items-center justify-between text-[11px] text-neutral-500 font-mono px-0.5">
                  <span>
                    Размер:{" "}
                    {recordedFile.size < 1024 * 1024
                      ? `${(recordedFile.size / 1024).toFixed(1)} KB`
                      : `${(recordedFile.size / (1024 * 1024)).toFixed(2)} MB`}
                  </span>
                  <span>
                    Кодек: {recordedFile.type || "audio"} (
                    {recordedFile.name.split(".").pop()?.toUpperCase()})
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
