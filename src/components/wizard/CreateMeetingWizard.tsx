import React, { useState, useEffect, useRef } from "react";
import {
  UploadCloud,
  Mic,
  FileText,
  ArrowRight,
  Globe,
  Loader2,
  CheckCircle2,
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  FileAudio,
  FileVideo,
  Trash2,
  Sparkles,
} from "lucide-react";
import { SteppeIcon } from "../ui/SteppeIcon";
import { AudioDropZone } from "./AudioDropZone";
import { AudioRecorder } from "./AudioRecorder";
import { ParticipantsInput } from "./ParticipantsInput";
import { AgendaInput } from "./AgendaInput";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import type { Participant } from "../../types";

export const CreateMeetingWizard: React.FC = () => {
  const { selectMeeting, loadMeetings } = useMeetingStore();

  const [inputTab, setInputTab] = useState<"file" | "record" | "text">("file");
  const [audioFile, setAudioFile] = useState<File | null>(null);

  const [title, setTitle] = useState(
    `Совещание ${new Date().toLocaleDateString("ru-RU")}`
  );
  const [sourceLanguage, setSourceLanguage] = useState("multi");
  const [agenda, setAgenda] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);

  // Step 3: Transcript state
  const [transcriptText, setTranscriptText] = useState("");
  const [draftMeetingId, setDraftMeetingId] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("");
  const [transcribeProgress, setTranscribeProgress] = useState(0);
  const [transcribeError, setTranscribeError] = useState("");
  const [copied, setCopied] = useState(false);

  // Polling ref to cancel on unmount if needed
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  // When audio file changes, reset transcript if it was from previous audio
  const handleAudioSelect = (file: File | null) => {
    setAudioFile(file);
    if (!file) {
      setDraftMeetingId(null);
      setTranscriptText("");
      setTranscribeError("");
    }
  };

  // Submission / generation state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

  // Statistics for transcript
  const wordCount = transcriptText.trim()
    ? transcriptText.trim().split(/\s+/).length
    : 0;
  const charCount = transcriptText.length;

  const handleCopyTranscript = () => {
    if (!transcriptText) return;
    navigator.clipboard.writeText(transcriptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Step-by-step Whisper transcription
  const handleTranscribeAudio = async () => {
    if (!audioFile) {
      setErrorMessage("Пожалуйста, сначала загрузите или запишите аудиофайл на Шаге 1");
      return;
    }

    try {
      setIsTranscribing(true);
      setTranscribeError("");
      setErrorMessage("");
      setTranscribeStatus("Создание черновика совещания...");

      let meetingId = draftMeetingId;
      if (!meetingId) {
        const created = await api.createMeeting({
          title: title.trim() || `Совещание ${new Date().toLocaleDateString("ru-RU")}`,
          source_language: sourceLanguage,
          agenda: agenda.trim(),
          participants,
          transcript_text: "",
        });
        meetingId = created.id;
        setDraftMeetingId(meetingId);
      } else {
        // Update meeting metadata if already created
        await api.updateMeeting(meetingId, {
          title: title.trim() || `Совещание ${new Date().toLocaleDateString("ru-RU")}`,
          source_language: sourceLanguage,
          agenda: agenda.trim(),
          participants,
        });
      }

      setTranscribeStatus("Загрузка аудиофайла на локальный сервер...");
      await api.uploadAudio(meetingId, audioFile);

      setTranscribeStatus("Распознавание речи...");
      setTranscribeProgress(0);
      await api.transcribe(meetingId);

      // Poll until transcribed or failed.
      //
      // The old version gave up after a fixed ~4 minutes, which killed the UI
      // on any recording longer than a short demo even though the backend was
      // still working. Now the deadline resets whenever progress moves, so only
      // a genuinely stalled job times out.
      const pollInterval = 1500;
      const stallLimit = 160; // ~4 minutes without any progress change
      let pollsSinceProgress = 0;
      let lastProgress = -1;

      const poll = async () => {
        try {
          const m = await api.getMeeting(meetingId!);

          const progress = m.progress ?? 0;
          if (progress !== lastProgress) {
            lastProgress = progress;
            pollsSinceProgress = 0;
          } else {
            pollsSinceProgress++;
          }

          setTranscribeProgress(progress);
          if (m.progress_label) setTranscribeStatus(m.progress_label);

          if (m.status === "transcribed" || (m.status as string) === "completed") {
            setTranscriptText(m.transcript_text || "");
            setIsTranscribing(false);
            setTranscribeStatus("");
            setTranscribeProgress(0);
            await loadMeetings();
            return;
          }
          if (m.status === "error") {
            setIsTranscribing(false);
            setTranscribeStatus("");
            setTranscribeProgress(0);
            setTranscribeError(m.error_message || "Ошибка распознавания речи Whisper");
            return;
          }
          if (pollsSinceProgress >= stallLimit) {
            setIsTranscribing(false);
            setTranscribeStatus("");
            setTranscribeProgress(0);
            setTranscribeError(
              "Обработка остановилась: за 4 минуты прогресс не изменился. " +
                "Проверьте, что Whisper-сервер доступен, в разделе «Настройки»."
            );
            return;
          }
          pollTimerRef.current = setTimeout(poll, pollInterval);
        } catch (err: any) {
          console.error("Polling error", err);
          setIsTranscribing(false);
          setTranscribeStatus("");
          setTranscribeProgress(0);
          setTranscribeError(err.message || "Ошибка проверки статуса транскрибации");
        }
      };

      pollTimerRef.current = setTimeout(poll, pollInterval);
    } catch (err: any) {
      console.error("Transcription start error", err);
      setIsTranscribing(false);
      setTranscribeStatus("");
      setTranscribeError(err.message || "Не удалось запустить транскрибацию");
    }
  };

  // Submit action: either generate protocol via LLM or just save transcript
  const handleFinalSubmit = async (onlySaveTranscript = false) => {
    setErrorMessage("");

    if (!transcriptText.trim()) {
      setErrorMessage(
        "Транскрипт пуст. Пожалуйста, выполните распознавание аудио на Шаге 3 или введите текст вручную."
      );
      return;
    }

    try {
      setIsSubmitting(true);
      let meetingId = draftMeetingId;

      if (meetingId) {
        setSubmitStep("Сохранение параметров и отредактированного транскрипта...");
        await api.updateMeeting(meetingId, {
          title: title.trim() || `Совещание ${new Date().toLocaleDateString("ru-RU")}`,
          source_language: sourceLanguage,
          agenda: agenda.trim(),
          participants,
          transcript_text: transcriptText.trim(),
        });
      } else {
        setSubmitStep("Создание записи совещания...");
        const created = await api.createMeeting({
          title: title.trim() || `Совещание ${new Date().toLocaleDateString("ru-RU")}`,
          source_language: sourceLanguage,
          agenda: agenda.trim(),
          participants,
          transcript_text: transcriptText.trim(),
        });
        meetingId = created.id;
      }

      if (!onlySaveTranscript) {
        setSubmitStep("Запуск генерации протокола языковой моделью (LLM)...");
        await api.generate(meetingId);
      }

      await loadMeetings();
      await selectMeeting(meetingId);
    } catch (err: any) {
      console.error("Submission failed", err);
      setErrorMessage(err.message || "Произошла ошибка при сохранении или генерации протокола");
      setIsSubmitting(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <span>Создать новое совещание</span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                Офлайн протокол
              </span>
            </h2>
            <p className="text-sm text-slate-400">
              Пошаговый процесс: выберите источник аудио или текста, настройте параметры, проверьте транскрипт и сформируйте официальный протокол.
            </p>
          </div>
        </div>

        {/* Step Progression Bar */}
        <div className="grid grid-cols-3 gap-2 pt-5">
          <div
            className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all ${
              (inputTab === "text" && transcriptText) || audioFile
                ? "bg-indigo-950/40 border-indigo-500/40 text-indigo-200"
                : "bg-slate-900/60 border-slate-800 text-slate-400"
            }`}
          >
            <div className="w-6 h-6 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-xs font-bold text-indigo-300 shrink-0">
              1
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate text-white">Источник данных</p>
              <p className="text-[11px] text-slate-400 truncate">
                {inputTab === "file" && (audioFile ? audioFile.name : "Файл не выбран")}
                {inputTab === "record" && (audioFile ? "Запись готова" : "Запись звука / встречи")}
                {inputTab === "text" && "Вручную"}
              </p>
            </div>
          </div>

          <div
            className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all ${
              title.trim()
                ? "bg-indigo-950/40 border-indigo-500/40 text-indigo-200"
                : "bg-slate-900/60 border-slate-800 text-slate-400"
            }`}
          >
            <div className="w-6 h-6 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-xs font-bold text-indigo-300 shrink-0">
              2
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate text-white">Параметры</p>
              <p className="text-[11px] text-slate-400 truncate">
                {title || "Название совещания"}
              </p>
            </div>
          </div>

          <div
            className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all ${
              transcriptText.trim()
                ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-200"
                : isTranscribing
                ? "bg-amber-950/40 border-amber-500/40 text-amber-200 animate-pulse"
                : "bg-slate-900/60 border-slate-800 text-slate-400"
            }`}
          >
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                transcriptText.trim()
                  ? "bg-emerald-600/30 border border-emerald-500/40 text-emerald-300"
                  : isTranscribing
                  ? "bg-amber-600/30 border border-amber-500/40 text-amber-300"
                  : "bg-slate-800 border border-slate-700 text-slate-400"
              }`}
            >
              {transcriptText.trim() ? "✓" : "3"}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate text-white">Транскрипт</p>
              <p className="text-[11px] text-slate-400 truncate">
                {isTranscribing
                  ? "Распознавание..."
                  : transcriptText.trim()
                  ? `${wordCount} слов`
                  : "Ожидает распознавания"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm flex items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="space-y-8">
        {/* Step 1: Input Source */}
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Шаг 1. Источник данных совещания
            </span>
            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setInputTab("file");
                  handleAudioSelect(null);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  inputTab === "file"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>Файл</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setInputTab("record");
                  handleAudioSelect(null);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  inputTab === "record"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <Mic className="w-3.5 h-3.5" />
                <span>Запись звука</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setInputTab("text");
                  handleAudioSelect(null);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  inputTab === "text"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Вставить текст</span>
              </button>
            </div>
          </div>

          {inputTab === "file" && (
            <AudioDropZone file={audioFile} onFileSelect={handleAudioSelect} />
          )}

          {inputTab === "record" && (
            <AudioRecorder onAudioReady={handleAudioSelect} />
          )}

          {inputTab === "text" && (
            <div className="space-y-2">
              <textarea
                rows={6}
                placeholder="Вставьте расшифровку аудио, стенограмму или заметки с совещания..."
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                className="w-full p-4 text-sm rounded-2xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors leading-relaxed font-sans"
              />
              <p className="text-xs text-slate-400">
                Текст автоматически отобразится на Шаге 3 для проверки перед запуском генерации официального протокола.
              </p>
            </div>
          )}
        </div>

        {/* Step 2: Protocol Parameters */}
        <div className="space-y-6 pt-4 border-t border-slate-800">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Шаг 2. Параметры протокола
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Тема / Название совещания
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Например: Еженедельная летучка команды разработки"
                className="w-full py-2.5 px-3.5 text-sm rounded-xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors font-medium"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-indigo-400" />
                <span>Язык совещания</span>
              </label>
              <select
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
                className="w-full py-2.5 px-3 text-sm rounded-xl bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-indigo-500 transition-colors font-medium"
              >
                <option value="multi">Смешанный (KZ / RU)</option>
                <option value="ru">Русский</option>
                <option value="kz">Қазақша</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>

          <AgendaInput agenda={agenda} onChange={setAgenda} />

          <ParticipantsInput
            participants={participants}
            onChange={setParticipants}
          />
        </div>

        {/* Step 3: Transcript (Стенограмма) */}
        <div className="space-y-4 pt-4 border-t border-slate-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Шаг 3. Транскрипт (Стенограмма)
              </span>
              {isTranscribing ? (
                <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-medium">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Распознавание Whisper...</span>
                </span>
              ) : transcriptText.trim() ? (
                <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-medium">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>
                    Транскрипт готов • {wordCount} слов ({charCount} симв.)
                  </span>
                </span>
              ) : (
                <span className="px-2.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400 text-xs font-medium">
                  {inputTab === "text" ? "Ожидает ввода" : "Ожидает распознавания"}
                </span>
              )}
            </div>

            {/* Quick Actions for Transcript */}
            {transcriptText.trim() && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCopyTranscript}
                  className="flex items-center gap-1.5 py-1 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                >
                  {copied ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copied ? "Скопировано" : "Копировать"}</span>
                </button>

                {(inputTab === "file" || inputTab === "record") && audioFile && (
                  <button
                    type="button"
                    onClick={handleTranscribeAudio}
                    disabled={isTranscribing}
                    className="flex items-center gap-1.5 py-1 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors disabled:opacity-50"
                    title="Запустить распознавание повторно"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Распознать заново</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setTranscriptText("")}
                  className="flex items-center gap-1 py-1 px-2 rounded-lg bg-slate-800/60 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 text-xs transition-colors"
                  title="Очистить транскрипт"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Transcript Content by Mode */}
          {inputTab === "file" || inputTab === "record" ? (
            <div className="space-y-4">
              {/* If no transcript yet and not transcribing */}
              {!transcriptText.trim() && !isTranscribing && (
                <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                  {audioFile ? (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                          {audioFile.type.startsWith("video/") ? (
                            <FileVideo className="w-5 h-5" />
                          ) : (
                            <FileAudio className="w-5 h-5" />
                          )}
                        </div>
                        <div>
                          <p className="font-semibold text-sm text-white truncate max-w-sm sm:max-w-md">
                            {audioFile.name}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {formatFileSize(audioFile.size)} • Аудиозапись готова к локальной обработке Whisper
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleTranscribeAudio}
                        className="flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-all shadow-md shadow-indigo-600/20 active:scale-95 shrink-0"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Распознать аудио (Whisper)</span>
                      </button>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center text-xs text-slate-400">
                      Сначала выберите файл или надиктуйте запись на Шаге 1 выше.
                    </div>
                  )}

                  {transcribeError && (
                    <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                        <span>{transcribeError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleTranscribeAudio}
                        className="text-xs underline font-semibold hover:text-rose-200 shrink-0"
                      >
                        Повторить
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Transcribing in progress */}
              {isTranscribing && (
                <div className="p-8 rounded-2xl bg-slate-900/90 border border-indigo-500/30 text-center space-y-4 shadow-xl shadow-indigo-500/5">
                  <div className="w-12 h-12 mx-auto rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 animate-spin">
                    <Loader2 className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold text-white">
                      {transcribeStatus || "Идет распознавание речи..."}
                    </h4>
                    <p className="text-xs text-slate-400 max-w-md mx-auto">
                      Whisper переводит речь в текст. После завершения текст появится ниже для проверки.
                    </p>
                  </div>

                  <div className="max-w-sm mx-auto space-y-1.5">
                    <div
                      className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden"
                      role="progressbar"
                      aria-valuenow={Math.round(transcribeProgress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all duration-700 ease-out"
                        style={{ width: `${Math.max(2, Math.min(100, transcribeProgress))}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                      {Math.round(transcribeProgress)}%
                    </p>
                  </div>
                </div>
              )}

              {/* Transcript ready (editable) */}
              {transcriptText.trim() && !isTranscribing && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>
                      Вы можете отредактировать текст перед отправкой в языковую модель (исправить имена, должности или термины):
                    </span>
                  </div>

                  <textarea
                    rows={10}
                    value={transcriptText}
                    onChange={(e) => setTranscriptText(e.target.value)}
                    placeholder="Текст расшифровки совещания..."
                    className="w-full p-4 text-sm rounded-2xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors leading-relaxed font-sans font-normal"
                  />
                </div>
              )}
            </div>
          ) : (
            /* Text mode */
            <div className="space-y-2">
              <textarea
                rows={9}
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                placeholder="Вставьте расшифровку аудио, стенограмму или заметки с совещания..."
                className="w-full p-4 text-sm rounded-2xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors leading-relaxed font-sans"
              />
              <p className="text-xs text-slate-400">
                Текст готов к отправке в языковую модель для формирования официального протокола.
              </p>
            </div>
          )}
        </div>

        {/* Submit & Step-by-Step Actions */}
        <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-slate-400">
            {!transcriptText.trim() && audioFile ? (
              <span className="text-amber-400 flex items-center gap-1.5 font-medium">
                <AlertCircle className="w-3.5 h-3.5" />
                Шаг 3: Нажмите «Распознать аудио (Whisper)» для получения стенограммы
              </span>
            ) : transcriptText.trim() ? (
              <span className="text-emerald-400 flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Стенограмма готова к формированию протокола
              </span>
            ) : (
              <span>Все вычисления выполняются локально на вашем компьютере.</span>
            )}
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            {/* If transcript is ready, provide option to save transcript without immediately running LLM */}
            {transcriptText.trim() && (
              <button
                type="button"
                disabled={isSubmitting || isTranscribing}
                onClick={() => handleFinalSubmit(true)}
                className="py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700 disabled:opacity-50"
              >
                Сохранить только транскрипт
              </button>
            )}

            {/* Primary Action: Generate Protocol */}
            <button
              type="button"
              disabled={isSubmitting || isTranscribing || (!transcriptText.trim() && !audioFile)}
              onClick={() => {
                if (!transcriptText.trim() && audioFile) {
                  // If audio is present but not transcribed, run transcription first
                  handleTranscribeAudio();
                } else {
                  handleFinalSubmit(false);
                }
              }}
              className="flex items-center justify-center gap-2.5 py-3 px-7 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-600 hover:from-indigo-500 hover:to-indigo-500 text-white font-semibold text-sm transition-all shadow-xl shadow-indigo-500/25 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{submitStep || "Генерация протокола..."}</span>
                </>
              ) : isTranscribing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Распознавание речи...</span>
                </>
              ) : !transcriptText.trim() && audioFile ? (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>1. Распознать аудио (Whisper)</span>
                  <ArrowRight className="w-4 h-4 ml-0.5" />
                </>
              ) : (
                <>
                  <SteppeIcon className="w-4 h-4" />
                  <span>Сформировать протокол (LLM)</span>
                  <ArrowRight className="w-4 h-4 ml-1" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
