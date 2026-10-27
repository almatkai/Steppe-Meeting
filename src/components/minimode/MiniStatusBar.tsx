import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Record, Stop, Microphone, MicrophoneSlash, ClosedCaptioning,
  Eye, EyeSlash, CornersOut, CircleNotch, DotsSixVertical, DownloadSimple,
  ArrowCounterClockwise, X, CaretDown, Check, WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../../services/api";
import { SteppeLogo } from "../ui/SteppeIcon";
import { invoke } from "@tauri-apps/api/core";
import { isTauriEnvironment, restoreMainWindow } from "../../utils/tauriWindow";
import { startMicrophoneRecording, describeRecordingError } from "../../utils/microphoneRecording";
import { startLiveCaptions, startAudioLevelMonitor } from "../../utils/liveCaptions";
import { finishAudioFile, submitMiniRecording, type SavedRecording } from "../../utils/recordingFinalization";
import { appendCaption, resetMiniRecording } from "../../utils/miniRecording";
import { suppressCaptureTooltips } from "../../utils/captureTooltips";
import type { WhisperStatus } from "../../types";

type Status = "idle" | "starting" | "recording" | "resetting" | "finishing" | "saving" | "processing" | "opening" | "error";

export const MiniStatusBar: React.FC = () => {
  const [status, setStatus] = useState<Status>("idle");
  const statusRef = useRef<Status>(status);
  statusRef.current = status;
  const [failedAction, setFailedAction] = useState<"save" | "reset" | "restart">("save");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCaptionsEnabled, setIsCaptionsEnabled] = useState(true);
  const [isCaptureProtected, setIsCaptureProtected] = useState(false);
  const [capturePending, setCapturePending] = useState(true);
  const [captureError, setCaptureError] = useState("");
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const captionScrollRef = useRef<HTMLDivElement | null>(null);
  const followCaptionsRef = useRef(true);
  const [activeCaption, setActiveCaption] = useState("");
  const [captionState, setCaptionState] = useState("listening");
  const [captionError, setCaptionError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const meetingIdRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const captionsRef = useRef<Awaited<ReturnType<typeof startLiveCaptions>> | null>(null);
  const levelMonitorRef = useRef<Awaited<ReturnType<typeof startAudioLevelMonitor>> | null>(null);
  const captionContextRef = useRef<AudioContext | null>(null);
  const savedRef = useRef<SavedRecording | null>(null);
  const sessionRef = useRef<string | null>(null);

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const releaseMicrophone = () => {
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    setAudioLevel(0);
  };

  const stopCaptions = async () => {
    const captions = captionsRef.current;
    captionsRef.current = null;
    if (captions) await captions.stop();

    const monitor = levelMonitorRef.current;
    levelMonitorRef.current = null;
    if (monitor) await monitor.stop();

    if (captionContextRef.current?.state !== "closed") await captionContextRef.current?.close();
    captionContextRef.current = null;
  };

  const formatErrorMessage = (error: unknown): string => {
    const raw = describeRecordingError(error);
    if (
      raw.includes("Failed to fetch") ||
      raw.includes("Load failed") ||
      raw.includes("NetworkError") ||
      raw.includes("ECONNREFUSED")
    ) {
      return "Бэкенд-сервер не запущен (порт 8008)";
    }
    if (raw.includes("NotAllowedError") || raw.includes("Permission denied")) {
      return "Доступ к микрофону запрещен в Настройках macOS";
    }
    return raw;
  };

  // Load whisper models on mount with periodic retry if backend is still booting
  useEffect(() => {
    let disposed = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchStatus = async () => {
      try {
        const ws = await api.getWhisperStatus();
        if (disposed) return;
        setWhisperStatus(ws);
        const active = ws.local?.selected_model || "small";
        if (statusRef.current === "idle") {
          setSelectedModelId(active);
          const catalogItem = ws.local?.catalog?.find((m) => m.id === active);
          if ((catalogItem?.size_mb ?? 0) > 200) setIsCaptionsEnabled(false);
        }
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch {
        if (!intervalId && !disposed) {
          intervalId = setInterval(() => void fetchStatus(), 2000);
        }
      }
    };

    void fetchStatus();

    const onFocus = () => void fetchStatus();
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      if (intervalId) clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const downloadedModels = useMemo(() => {
    if (!whisperStatus?.local?.catalog) return [];
    const available = new Set(whisperStatus.local.available_models || []);
    return whisperStatus.local.catalog.filter(
      (m) => m.downloaded || available.has(m.id)
    );
  }, [whisperStatus]);

  const currentModelInfo = downloadedModels.find((m) => m.id === selectedModelId)
    || whisperStatus?.local?.catalog?.find((m) => m.id === selectedModelId);
  const isHeavyModel = (currentModelInfo?.size_mb ?? 0) > 200;

  const modelShortName = currentModelInfo
    ? currentModelInfo.name.replace(/Whisper\s+|Vosk\s+Small\s+/gi, "")
    : selectedModelId ? selectedModelId.replace(/whisper-|vosk-/gi, "") : "Модель";

  // Window size control: 320px in idle, expands to 395px during recording/processing so all controls fit
  const showCaptions = ["recording", "finishing"].includes(status) && isCaptionsEnabled && Boolean(captionsRef.current);
  const isRecordingOrActive = status !== "idle";

  const targetWidth = useMemo(() => {
    if (isRecordingOrActive) return 395.0;
    return 320.0;
  }, [isRecordingOrActive]);

  const targetHeight = useMemo(() => {
    if (isModelMenuOpen) return 168.0;
    if (errorMessage || captionError || captureError) return 72.0;
    if (showCaptions) return 76.0;
    return 36.0;
  }, [isModelMenuOpen, errorMessage, captionError, captureError, showCaptions]);

  useEffect(() => {
    if (isTauriEnvironment()) {
      void invoke("set_mini_size", { width: targetWidth, height: targetHeight }).catch(console.error);
    }
  }, [targetWidth, targetHeight]);

  const toggleModelMenu = () => {
    if (status !== "idle" || processing) return;
    setIsModelMenuOpen((prev) => !prev);
    setErrorMessage("");
  };

  const handleSelectModel = async (modelId: string) => {
    setIsModelMenuOpen(false);
    setSelectedModelId(modelId);
    const chosen = downloadedModels.find((m) => m.id === modelId)
      || whisperStatus?.local?.catalog?.find((m) => m.id === modelId);
    const heavy = (chosen?.size_mb ?? 0) > 200;
    if (heavy) {
      setIsCaptionsEnabled(false);
    }
    try {
      await api.saveConfig({ whisper_local_model: modelId, whisper_mode: "local" });
      const refreshed = await api.getWhisperStatus();
      setWhisperStatus(refreshed);
    } catch (err: unknown) {
      setErrorMessage("Не удалось сменить модель: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  useEffect(() => {
    document.documentElement.classList.add("mini-mode");
    return () => {
      document.documentElement.classList.remove("mini-mode");
      clearTimer();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      void stopCaptions().catch(console.error);
      micRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) { setCapturePending(false); return; }
    let disposed = false;
    invoke<boolean>("set_mini_capture_protection", { enabled: true }).then((enabled) => {
      if (!disposed) { setIsCaptureProtected(enabled); setCaptureError(""); }
    }).catch((error) => {
      if (!disposed) setCaptureError(`Защита: ${String(error)}`);
    }).finally(() => { if (!disposed) setCapturePending(false); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (rootRef.current && (isCaptureProtected || capturePending || captureError)) return suppressCaptureTooltips(rootRef.current);
  }, [isCaptureProtected, capturePending, captureError]);

  useEffect(() => {
    if (followCaptionsRef.current && captionScrollRef.current) captionScrollRef.current.scrollTop = captionScrollRef.current.scrollHeight;
  }, [activeCaption, showCaptions]);

  const toggleCaptureProtection = async () => {
    if (capturePending) return;
    if (!isTauriEnvironment()) { setCaptureError("Защита от захвата доступна в десктопном Mini."); return; }
    setCapturePending(true);
    try {
      const enabled = await invoke<boolean>("set_mini_capture_protection", { enabled: captureError ? true : !isCaptureProtected });
      setIsCaptureProtected(enabled); setCaptureError("");
    } catch (error) { setCaptureError(`Защита: ${String(error)}`); }
    finally { setCapturePending(false); }
  };

  const startRecording = async (preparedContext?: AudioContext, restarting = false) => {
    if (busyRef.current || (!restarting && status !== "idle")) return;
    busyRef.current = true;
    setIsModelMenuOpen(false);
    setStatus("starting");
    setErrorMessage(""); setCaptionError(""); setActiveCaption("");
    setRecordingSeconds(0); followCaptionsRef.current = true;
    chunksRef.current = []; savedRef.current = null; meetingIdRef.current = null;
    try {
      captionContextRef.current = preparedContext || new AudioContext();
      void captionContextRef.current.resume().catch(console.error);
      const now = new Date();
      const result = await api.createMeeting({
        title: `Встреча ${now.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`,
        source_language: "multi", agenda: "Запись из Steppe Mini",
      });
      meetingIdRef.current = result.id;
      const session = await api.startRecordingSession(result.id);
      sessionRef.current = session.session_id;
      const { stream, recorder } = await startMicrophoneRecording(
        (chunk) => chunksRef.current.push(chunk), isMicMuted,
      );
      micRef.current = stream; recorderRef.current = recorder;

      const shouldStreamCaptions = isCaptionsEnabled && !isHeavyModel;
      if (shouldStreamCaptions) {
        captionsRef.current = await startLiveCaptions(stream, {
          transcribe: (audio, signal, chunk) => api.transcribeCaption(audio, signal, chunk, session.session_id),
          onText: (text) => { setActiveCaption((previous) => appendCaption(previous, text)); setCaptionError(""); },
          onState: (state, message) => {
            setCaptionState(state);
            setCaptionError(state === "error" ? message || "Не удалось распознать фрагмент. Повторяем…" : "");
          },
          onLevel: setAudioLevel,
        }, captionContextRef.current);
      } else {
        levelMonitorRef.current = await startAudioLevelMonitor(stream, setAudioLevel, captionContextRef.current);
      }

      setStatus("recording");
      timerRef.current = setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
    } catch (error) {
      const emptyMeeting = meetingIdRef.current;
      if (emptyMeeting) await api.deleteMeeting(emptyMeeting).catch(console.error);
      meetingIdRef.current = null; sessionRef.current = null;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      await stopCaptions().catch(console.error);
      releaseMicrophone(); clearTimer();
      recorderRef.current = null;
      setStatus("idle");
      const message = formatErrorMessage(error);
      setErrorMessage(message);
    } finally { busyRef.current = false; }
  };

  const stopAndSave = async () => {
    if (busyRef.current) return;
    const meetingId = meetingIdRef.current;
    if (!meetingId || !recorderRef.current) return;
    busyRef.current = true;
    clearTimer(); setStatus("finishing"); setFailedAction("save"); setErrorMessage("");
    try {
      // CC changes visibility during recording; the existing stream determines
      // finalization, even when its panel is hidden before Stop.
      if (captionsRef.current && sessionRef.current) {
        const captions = captionsRef.current;
        const sessionId = sessionRef.current;
        const transcriptResult = savedRef.current?.transcript
          ? Promise.resolve({ value: savedRef.current.transcript, error: null })
          : captions.finish().then(
            (result) => ({ value: { session_id: sessionId, ...result }, error: null }),
            (error: unknown) => ({ value: null, error }),
          );
        if (!savedRef.current) {
          const file = await finishAudioFile(recorderRef.current, chunksRef.current);
          savedRef.current = { meetingId, file, uploaded: false };
        }
        releaseMicrophone();
        if (!savedRef.current.uploaded) {
          setStatus("saving");
          await api.uploadAudio(meetingId, savedRef.current.file);
          savedRef.current.uploaded = true;
        }
        setStatus("finishing");
        const transcript = await transcriptResult;
        if (transcript.error) throw transcript.error;
        if (!transcript.value) throw new Error("Не удалось завершить транскрипт.");
        savedRef.current.transcript = transcript.value;
        await submitMiniRecording(savedRef.current, {
          uploadAudio: api.uploadAudio,
          processRecording: api.processRecording,
          openMeeting: restoreMainWindow,
          onStage: setStatus,
        });
      } else {
        if (!savedRef.current) {
          const file = await finishAudioFile(recorderRef.current, chunksRef.current);
          savedRef.current = { meetingId, file, uploaded: false };
        }
        releaseMicrophone();
        if (!savedRef.current.uploaded) {
          setStatus("saving");
          await api.uploadAudio(meetingId, savedRef.current.file);
          savedRef.current.uploaded = true;
        }
        setStatus("processing");
        await submitMiniRecording(savedRef.current, {
          uploadAudio: api.uploadAudio,
          transcribeMeeting: (id, autoGen) => api.transcribe(id, autoGen),
          openMeeting: restoreMainWindow,
          onStage: setStatus,
        });
      }

      await stopCaptions();
      setStatus("idle"); recorderRef.current = null; sessionRef.current = null;
      chunksRef.current = []; savedRef.current = null; meetingIdRef.current = null;
    } catch (error) {
      releaseMicrophone();
      setStatus("error");
      setErrorMessage(formatErrorMessage(error));
    } finally { busyRef.current = false; }
  };

  const resetRecording = async (restart = false) => {
    if (busyRef.current || !meetingIdRef.current || !sessionRef.current || !recorderRef.current) return;
    let nextContext: AudioContext | undefined;
    if (restart) {
      try { nextContext = new AudioContext(); void nextContext.resume().catch(console.error); }
      catch (error) { setErrorMessage(formatErrorMessage(error)); return; }
    }
    busyRef.current = true; clearTimer(); setStatus("resetting"); setFailedAction(restart ? "restart" : "reset"); setErrorMessage("");
    try {
      await resetMiniRecording({
        meetingId: meetingIdRef.current, sessionId: sessionRef.current,
        recorder: recorderRef.current, chunks: chunksRef.current, saved: savedRef.current,
      }, {
        finishAudio: finishAudioFile, cancelCaptions: stopCaptions, releaseMicrophone,
        retainFile: (saved) => { savedRef.current = saved; },
        uploadAudio: api.uploadAudio, cancelSession: api.cancelRecording,
      });
      recorderRef.current = null; meetingIdRef.current = null; sessionRef.current = null;
      chunksRef.current = []; savedRef.current = null;
      setActiveCaption(""); setCaptionError(""); setCaptionState("listening");
      setRecordingSeconds(0); setStatus("idle");
      busyRef.current = false;
      if (restart) await startRecording(nextContext, true);
    } catch (error) {
      if (nextContext?.state !== "closed") await nextContext?.close().catch(console.error);
      setStatus("error"); setErrorMessage(formatErrorMessage(error));
    } finally { busyRef.current = false; }
  };

  const downloadRecording = () => {
    const file = savedRef.current?.file;
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleMic = () => {
    const muted = !isMicMuted;
    micRef.current?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    setIsMicMuted(muted);
  };

  const toggleCaptions = () => {
    if (isHeavyModel) {
      setErrorMessage(`Модель ${modelShortName} >200 МБ: анализ после записи`);
      return;
    }
    setIsCaptionsEnabled((prev) => !prev);
    followCaptionsRef.current = true;
  };

  const handleDrag = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !isTauriEnvironment()) return;
    event.preventDefault();
    void invoke("drag_mini_window").catch(console.error);
  };

  const handleExpand = () => {
    void restoreMainWindow(meetingIdRef.current || undefined).catch((error) => {
      setErrorMessage(String(error));
    });
  };

  const handleHide = () => {
    void invoke("hide_mini_window").catch((error) => {
      setErrorMessage(String(error));
    });
  };

  const timer = `${Math.floor(recordingSeconds / 60).toString().padStart(2, "0")}:${(recordingSeconds % 60).toString().padStart(2, "0")}`;
  const processing = ["starting", "resetting", "finishing", "saving", "processing", "opening"].includes(status);
  const stageLabel = {
    starting: "Подготовка…",
    resetting: "Сброс…",
    finishing: "Завершение…",
    saving: "Сохранение…",
    processing: "Анализ…",
    opening: "Открытие…",
  };

  const caption = activeCaption || (
    status === "recording" || status === "starting"
      ? isMicMuted ? "Микрофон выключен" : captionState === "recognizing" ? "Распознаю…" : "Слушаю…"
      : ""
  );

  const toggleStyle = "mini-toggle";
  const captureLabel = captureError ? "Ошибка защиты" : isCaptureProtected ? "Показывать Mini в захвате" : "Скрыть Mini из захвата";

  const resetActions = (
    <>
      <button onClick={() => void resetRecording()} className="mini-secondary" aria-label="Сброс" title="Сбросить запись"><X className="w-2.5 h-2.5" /></button>
      <button onClick={() => void resetRecording(true)} className="mini-secondary" aria-label="Заново" title="Начать заново"><ArrowCounterClockwise className="w-2.5 h-2.5" /></button>
    </>
  );

  return (
    <div ref={rootRef} className="mini-shell">
      <div className="mini-controls">
        <button type="button" onMouseDown={handleDrag} aria-label="Перетащить" title="Перетащить" className="mini-grip">
          <DotsSixVertical className="w-2.5 h-3 text-neutral-500 pointer-events-none" />
          <SteppeLogo className="w-3.5 h-3.5 pointer-events-none" />
        </button>

        {/* Custom STT Model Dropdown Pill */}
        <button
          type="button"
          disabled={status !== "idle" || processing}
          onClick={toggleModelMenu}
          className="mini-model-pill"
          title={
            isHeavyModel
              ? `Модель ${modelShortName} (${currentModelInfo?.size_mb || 0} МБ) > 200 МБ. Субтитры отключены.`
              : `STT: ${modelShortName} (${currentModelInfo?.size_mb || 0} МБ)`
          }
        >
          <span className="truncate max-w-[55px]">
            {isHeavyModel ? "📦 " : "⚡ "}
            {modelShortName}
          </span>
          <CaretDown className={`w-2 h-2 text-neutral-400 shrink-0 transition-transform ${isModelMenuOpen ? "rotate-180" : ""}`} />
        </button>

        <div className="mini-actions">
          {status === "idle" && (
            <button onClick={() => void startRecording()} className="mini-primary" title="Начать запись">
              <Record className="w-2.5 h-2.5 text-rose-500" weight="fill" />
              <span>Запись</span>
            </button>
          )}
          {status === "recording" && (
            <>
              <span className="mini-timer">
                <span className="w-1.5 h-1.5 bg-rose-500 rounded-full animate-pulse" />
                {timer}
              </span>
              <div aria-label="Уровень микрофона" className="w-2.5 h-1 bg-neutral-700 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-400" style={{ width: `${audioLevel}%` }} />
              </div>
              <button onClick={() => void stopAndSave()} className="mini-primary" title="Стоп">
                <Stop className="w-2.5 h-2.5 text-neutral-900" weight="fill" />
                <span>Стоп</span>
              </button>
              {resetActions}
            </>
          )}
          {processing && (
            <span className="flex items-center gap-1 text-[9.5px] text-neutral-300">
              <CircleNotch className="w-2.5 h-2.5 animate-spin text-emerald-400" />
              {stageLabel[status as keyof typeof stageLabel]}
            </span>
          )}
          {status === "error" && (
            <>
              <button onClick={() => void (failedAction === "save" ? stopAndSave() : resetRecording(failedAction === "restart"))} className="mini-primary">
                {failedAction === "save" ? "Повторить" : "Сброс"}
              </button>
              {resetActions}
              {savedRef.current && (
                <button onClick={downloadRecording} aria-label="Скачать" title="Скачать аудио" className={toggleStyle}>
                  <DownloadSimple className="w-2.5 h-2.5" />
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={toggleMic}
            disabled={processing}
            className={`${toggleStyle} ${isMicMuted ? "mini-toggle-active" : ""}`}
            title={isMicMuted ? "Включить микрофон" : "Выключить микрофон"}
            aria-label={isMicMuted ? "Включить микрофон" : "Выключить микрофон"}
          >
            {isMicMuted ? <MicrophoneSlash className="w-2.5 h-2.5" /> : <Microphone className="w-2.5 h-2.5" />}
          </button>
          <button
            onClick={toggleCaptions}
            className={`${toggleStyle} ${isCaptionsEnabled && !isHeavyModel ? "mini-toggle-active" : ""} ${isHeavyModel ? "opacity-30 cursor-not-allowed" : ""}`}
            title={
              isHeavyModel
                ? `Субтитры недоступны для тяжёлой модели (>200 МБ: ${modelShortName})`
                : isCaptionsEnabled
                  ? "Отключить субтитры"
                  : "Включить субтитры"
            }
            aria-label="Субтитры"
            aria-pressed={isCaptionsEnabled && !isHeavyModel}
          >
            <ClosedCaptioning className="w-2.5 h-2.5" />
          </button>
          <button
            onClick={() => void toggleCaptureProtection()}
            disabled={capturePending}
            className={`${toggleStyle} ${isCaptureProtected && !captureError ? "mini-toggle-active" : ""}`}
            title={captureLabel}
            aria-label={captureLabel}
            aria-pressed={isCaptureProtected && !captureError}
          >
            {capturePending ? <CircleNotch className="w-2.5 h-2.5 animate-spin" /> : isCaptureProtected ? <EyeSlash className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
          </button>
          <button
            onClick={handleExpand}
            disabled={status === "recording" || processing}
            className={toggleStyle}
            title="Развернуть"
            aria-label="Развернуть"
          >
            <CornersOut className="w-2.5 h-2.5" />
          </button>
          <button
            onClick={handleHide}
            className={toggleStyle}
            title="Скрыть"
            aria-label="Скрыть"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* Model Selection Dropdown Card */}
      {isModelMenuOpen && (
        <div className="mini-model-dropdown">
          <div className="flex items-center justify-between px-2 py-1 border-b border-neutral-800 text-[10px] text-neutral-400 font-medium">
            <span>Скачанные модели ({downloadedModels.length})</span>
            <button
              type="button"
              onClick={() => setIsModelMenuOpen(false)}
              className="text-neutral-500 hover:text-neutral-200"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
          <div className="mini-model-list">
            {downloadedModels.length > 0 ? (
              downloadedModels.map((m) => {
                const active = m.id === selectedModelId;
                const heavy = m.size_mb > 200;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => void handleSelectModel(m.id)}
                    className={`mini-model-item ${active ? "mini-model-item-active" : ""}`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px]">{heavy ? "📦" : "⚡"}</span>
                      <span className="truncate font-medium">{m.name.replace(/Whisper\s+|Vosk\s+Small\s+/gi, "")}</span>
                      <span className="text-[9px] text-neutral-400">({m.size_mb}M)</span>
                    </div>
                    {active && <Check className="w-3 h-3 text-emerald-400 shrink-0" />}
                  </button>
                );
              })
            ) : (
              <div className="p-2 text-center text-[10px] text-neutral-500">
                Нет скачанных моделей
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error Banner: 100% visible, neatly styled and dismissible */}
      {(errorMessage || captionError || captureError) && !isModelMenuOpen && (
        <div className="mini-error-banner" role="alert">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <WarningCircle className="w-3 h-3 text-rose-400 shrink-0" weight="fill" />
            <span className="text-[9.5px] leading-tight text-rose-200 truncate">
              {errorMessage || captionError || captureError}
            </span>
          </div>
          <button
            type="button"
            onClick={() => { setErrorMessage(""); setCaptionError(""); setCaptureError(""); }}
            className="text-rose-400 hover:text-white p-0.5 shrink-0"
            title="Закрыть"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      )}

      {/* Live Captions (only rendered when recording with light model) */}
      {showCaptions && !errorMessage && !isModelMenuOpen && (
        <section className="mini-captions" aria-label="Субтитры">
          <div
            ref={captionScrollRef}
            className="mini-captions-text text-neutral-200"
            role="log"
            aria-live="polite"
            aria-label="Текст субтитров"
            onScroll={(event) => {
              const element = event.currentTarget;
              followCaptionsRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
            }}
          >
            {caption}
          </div>
        </section>
      )}
    </div>
  );
};
