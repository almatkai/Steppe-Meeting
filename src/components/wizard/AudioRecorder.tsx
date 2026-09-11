import React, { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Square,
  Trash2,
  CheckCircle2,
  Info,
  Sliders,
  AlertTriangle,
  Zap,
} from "lucide-react";

interface AudioRecorderProps {
  onAudioReady: (file: File | null) => void;
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
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");

  const isTauri = checkIsTauri();

  // Source selection states
  const [includeMic, setIncludeMic] = useState(true);
  const [includeSystem, setIncludeSystem] = useState(true);
  const [activeSources, setActiveSources] = useState<{ mic: boolean; system: boolean }>({
    mic: true,
    system: true,
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<any>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const prevBarsRef = useRef<number[]>(new Array(52).fill(6));

  // Cleanup on unmount
  useEffect(() => {
    return () => {
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
          const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
          bgGrad.addColorStop(0, "#030712");
          bgGrad.addColorStop(1, "#0b0f19");
          ctx.fillStyle = bgGrad;
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

              const gradient = ctx.createLinearGradient(0, y, 0, y + smoothed);
              gradient.addColorStop(0, "#38bdf8");
              gradient.addColorStop(0.5, "#6366f1");
              gradient.addColorStop(1, "#a855f7");

              ctx.save();
              if (rawVal > 35) {
                ctx.shadowBlur = 12;
                ctx.shadowColor = "rgba(99, 102, 241, 0.6)";
              }
              ctx.fillStyle = gradient;
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

              const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
              grad.addColorStop(0, "#34d399");
              grad.addColorStop(0.6, "#10b981");
              grad.addColorStop(1, "#059669");

              ctx.fillStyle = grad;
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

    // -------------------------------------------------------------
    // OPTION A: NATIVE TAURI / RUST ScreenCaptureKit RECORDING
    // No browser picker dialog, records system audio directly!
    // -------------------------------------------------------------
    const isRunningInTauri = isTauri || checkIsTauri();
    if (isRunningInTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke<string>("start_native_recording", {
          recordMic: includeMic,
        });

        setIsNativeRecording(true);
        setIsRecording(true);
        setRecordingTime(0);
        setActiveSources({ mic: includeMic, system: includeSystem });

        // Optional: Also attach mic to visualizer for live wave feedback if mic is enabled
        if (includeMic && navigator.mediaDevices?.getUserMedia) {
          try {
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStreamRef.current = micStream;
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            audioContextRef.current = audioCtx;
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyserRef.current = analyser;
            const src = audioCtx.createMediaStreamSource(micStream);
            src.connect(analyser);
          } catch (_) {}
        }

        timerRef.current = setInterval(() => {
          setRecordingTime((prev) => prev + 1);
        }, 1000);
        return;
      } catch (nativeErr: any) {
        console.error("Native recording error:", nativeErr);
        const errString = String(nativeErr);
        if (
          errString.includes("permission") ||
          errString.includes("Screen Recording") ||
          errString.includes("-3801") ||
          errString.includes("shareable content")
        ) {
          setError(
            "Для нативной записи системного звука откройте: «Системные настройки» -> «Конфиденциальность и безопасность» -> «Запись экрана и системного аудио» и разрешите Steppe Meeting."
          );
        } else {
          setError(`Ошибка нативной записи звука: ${errString}`);
        }
        return;
      }
    }

    // -------------------------------------------------------------
    // OPTION B: WEB FALLBACK (When running in browser outside Tauri)
    // -------------------------------------------------------------
    let micStream: MediaStream | null = null;
    let displayStream: MediaStream | null = null;
    let micConnected = false;
    let systemConnected = false;

    try {
      if (includeSystem) {
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
            return;
          }
        } catch (displayErr: any) {
          if (displayErr.name === "NotAllowedError" || displayErr.name === "AbortError") {
            setError(
              "Выбор был отменен. Чтобы записать звук системы, в верхней панели нажмите «Поделиться всем экраном»."
            );
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
              echoCancellation: true,
              noiseSuppression: true,
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

      if (!micConnected && !systemConnected) {
        setError("Не удалось подключить ни один источник звука.");
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
        micGain.gain.value = 1.0;
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
          onAudioReady(file);

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
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
      if (displayStreamRef.current) {
        displayStreamRef.current.getTracks().forEach((t) => t.stop());
        displayStreamRef.current = null;
      }
      setError("Ошибка при запуске записи: " + (err.message || String(err)));
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;

    // Stop native recording
    if (isNativeRecording) {
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
        onAudioReady(file);

        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setIsNativeRecording(false);
      } catch (err: any) {
        console.error("Stop native recording error:", err);
        setError("Ошибка остановки нативной записи: " + (err.message || String(err)));
        setIsNativeRecording(false);
      }
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
    setError("");
    onAudioReady(null);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="rounded-2xl border border-slate-700/80 bg-slate-900/50 p-6 space-y-4">
      {error && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1 leading-relaxed">{error}</div>
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
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/70 border border-slate-800">
            <div className="text-xs text-slate-300 font-medium flex items-center gap-2">
              <Sliders className="w-4 h-4 text-indigo-400" />
              <span>Источники аудио:</span>
              {isTauri && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                  <Zap className="w-3 h-3 text-emerald-400" />
                  Native Rust Engine
                </span>
              )}
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
                    ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/40 shadow-sm"
                    : "bg-slate-900/60 text-slate-500 border-slate-800 hover:text-slate-400"
                }`}
                title="Записывать ваш голос через микрофон"
              >
                {includeMic ? <Mic className="w-3.5 h-3.5 text-indigo-400" /> : <MicOff className="w-3.5 h-3.5" />}
                <span>Микрофон</span>
                {includeMic && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 ml-0.5" />}
              </button>

              {/* System Sound Toggle */}
              <button
                type="button"
                onClick={() => {
                  if (includeSystem && !includeMic) return;
                  setIncludeSystem(!includeSystem);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
                  includeSystem
                    ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/40 shadow-sm"
                    : "bg-slate-900/60 text-slate-500 border-slate-800 hover:text-slate-400"
                }`}
                title="Записывать системный звук (собеседников в Zoom, Meet, Teams, звонках или видео)"
              >
                {includeSystem ? (
                  <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
                <span>Звук системы</span>
                {includeSystem && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 ml-0.5" />}
              </button>
            </div>
          </div>

          {/* Guidance Info Banner */}
          {includeSystem && (
            <div className="p-3 rounded-xl bg-indigo-950/30 border border-indigo-500/25 text-xs text-indigo-200/90 flex items-start gap-2.5 leading-relaxed">
              <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
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
        <div className="w-full h-28 mb-4 rounded-2xl overflow-hidden border border-slate-800 bg-slate-950 relative flex items-center justify-center shadow-inner">
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
              <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-slate-900/80 border border-slate-800/80 text-slate-400 text-xs font-medium backdrop-blur-sm shadow-sm">
                {includeSystem && includeMic ? (
                  <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
                ) : includeSystem ? (
                  <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
                ) : (
                  <Mic className="w-3.5 h-3.5 text-indigo-400" />
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
              className="flex items-center gap-2.5 py-3 px-8 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-medium text-sm transition-all shadow-lg shadow-indigo-600/30 active:scale-95 cursor-pointer"
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
              className="flex items-center gap-2.5 py-3 px-8 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-medium text-sm transition-all shadow-lg shadow-rose-600/30 active:scale-95 cursor-pointer animate-pulse"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>Остановить запись</span>
            </button>
          )}

          {recordedFile && !isRecording && (
            <div className="flex flex-col items-center gap-3 w-full max-w-lg">
              {/* Audio Player Card */}
              <div className="w-full p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col gap-3 shadow-inner">
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
                    onClick={discardRecording}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 text-xs transition-colors cursor-pointer"
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
                    className="w-full h-11 rounded-lg accent-indigo-500 bg-slate-900 border border-slate-800"
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

                <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono px-0.5">
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
