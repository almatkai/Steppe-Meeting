import React, { useState, useEffect, useRef } from "react";
import {
  UploadCloud,
  Mic,
  FileText,
  ArrowRight,
  ArrowLeft,
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
  LayoutTemplate,
  Lock,
} from "lucide-react";
import { SteppeIcon } from "../ui/SteppeIcon";
import { AudioDropZone } from "./AudioDropZone";
import { AudioRecorder } from "./AudioRecorder";
import { ParticipantsInput } from "./ParticipantsInput";
import { AgendaInput } from "./AgendaInput";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import type { Participant, ProtocolTemplate } from "../../types";

export const CreateMeetingWizard: React.FC = () => {
  const { selectMeeting, loadMeetings, setView, systemStatus } = useMeetingStore();

  // Wizard active step: defaults to Step 1
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [inputTab, setInputTab] = useState<"file" | "record" | "text">("file");

  // Step 1 sources kept distinct so tab-switching doesn't lose user data
  const [uploadedAudioFile, setUploadedAudioFile] = useState<File | null>(null);
  const [recordedAudioFile, setRecordedAudioFile] = useState<File | null>(null);
  const [manualText, setManualText] = useState("");

  const activeAudioFile =
    inputTab === "file"
      ? uploadedAudioFile
      : inputTab === "record"
      ? recordedAudioFile
      : null;

  // Step 2 parameters
  const [title, setTitle] = useState(
    `Совещание ${new Date().toLocaleDateString("ru-RU")}`
  );
  const [sourceLanguage, setSourceLanguage] = useState("multi");
  const [agenda, setAgenda] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [templates, setTemplates] = useState<ProtocolTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templatesError, setTemplatesError] = useState(false);

  // Step 3: Transcript state
  const [transcriptText, setTranscriptText] = useState("");
  const [draftMeetingId, setDraftMeetingId] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("");
  const [transcribeError, setTranscribeError] = useState("");
  const [copied, setCopied] = useState(false);

  // Polling ref to cancel on unmount if needed
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load custom protocol templates for Step 2 selector
  const loadWizardTemplates = () => {
    setTemplatesError(false);
    api.listTemplates()
      .then((list) => setTemplates(list.filter((t) => t.id !== "default-protocol-template")))
      .catch(() => {
        setTemplates([]);
        setTemplatesError(true);
      });
  };

  useEffect(() => {
    loadWizardTemplates();
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  // Validation criteria: Step 1 is completed only if audio file, recorded audio or text is present
  const isStep1Complete = Boolean(
    inputTab === "file"
      ? uploadedAudioFile
      : inputTab === "record"
      ? recordedAudioFile
      : (manualText.trim().length > 0 || transcriptText.trim().length > 0)
  );

  const isStep2Complete = Boolean(title.trim().length > 0);

  // Submission / generation state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

  // Statistics for transcript
  const effectiveTranscriptText =
    inputTab === "text" ? transcriptText || manualText : transcriptText;
  const wordCount = effectiveTranscriptText.trim()
    ? effectiveTranscriptText.trim().split(/\s+/).length
    : 0;
  const charCount = effectiveTranscriptText.length;

  const handleCopyTranscript = () => {
    if (!effectiveTranscriptText) return;
    navigator.clipboard.writeText(effectiveTranscriptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Step-by-step Whisper transcription
  const handleTranscribeAudio = async () => {
    const fileToTranscribe = activeAudioFile;
    if (!fileToTranscribe) {
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
          template_id: selectedTemplateId || "",
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
          template_id: selectedTemplateId || "",
        });
      }

      setTranscribeStatus("Загрузка аудиофайла на локальный сервер...");
      await api.uploadAudio(meetingId, fileToTranscribe);

      setTranscribeStatus("Локальный Whisper выполняет распознавание речи...");
      await api.transcribe(meetingId);

      // Poll status until transcribed or error
      const pollInterval = 1500;
      const maxAttempts = 160; // ~4 minutes
      let attempts = 0;

      const poll = async () => {
        try {
          attempts++;
          const m = await api.getMeeting(meetingId!);
          if (m.status === "transcribed" || (m.status as string) === "completed") {
            setTranscriptText(m.transcript_text || "");
            setIsTranscribing(false);
            setTranscribeStatus("");
            await loadMeetings();
            return;
          }
          if (m.status === "error") {
            setIsTranscribing(false);
            setTranscribeStatus("");
            setTranscribeError(m.error_message || "Ошибка распознавания речи Whisper");
            return;
          }
          if (attempts >= maxAttempts) {
            setIsTranscribing(false);
            setTranscribeStatus("");
            setTranscribeError("Превышено время ожидания ответа от Whisper сервера");
            return;
          }
          pollTimerRef.current = setTimeout(poll, pollInterval);
        } catch (err: any) {
          console.error("Polling error", err);
          setIsTranscribing(false);
          setTranscribeStatus("");
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

    const textToSubmit = inputTab === "text"
      ? (transcriptText.trim() || manualText.trim())
      : transcriptText.trim();

    if (!textToSubmit) {
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
          transcript_text: textToSubmit,
          template_id: selectedTemplateId || "",
        });
      } else {
        setSubmitStep("Создание записи совещания...");
        const created = await api.createMeeting({
          title: title.trim() || `Совещание ${new Date().toLocaleDateString("ru-RU")}`,
          source_language: sourceLanguage,
          agenda: agenda.trim(),
          participants,
          transcript_text: textToSubmit,
          template_id: selectedTemplateId || "",
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

        {/* Step Progression Stepper */}
        <div className="grid grid-cols-3 gap-3 pt-5">
          {/* Step 1: Источник данных */}
          <button
            type="button"
            onClick={() => setCurrentStep(1)}
            className={`p-3 rounded-xl border flex items-center gap-2.5 text-left transition-all cursor-pointer ${
              currentStep === 1
                ? "bg-indigo-950/60 border-indigo-500 ring-2 ring-indigo-500/30 text-indigo-200 shadow-md shadow-indigo-500/10"
                : isStep1Complete
                ? "bg-indigo-950/30 border-indigo-500/40 text-indigo-200 hover:border-indigo-400/60"
                : "bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700"
            }`}
          >
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                isStep1Complete
                  ? "bg-emerald-600/30 border border-emerald-500/60 text-emerald-300"
                  : currentStep === 1
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-slate-800 border border-slate-700 text-slate-400"
              }`}
            >
              {isStep1Complete ? <Check className="w-3.5 h-3.5" /> : "1"}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold truncate text-white">Источник данных</p>
                {isStep1Complete && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-medium">
                    готов
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 truncate mt-0.5">
                {inputTab === "file" && (uploadedAudioFile ? uploadedAudioFile.name : "Файл не выбран")}
                {inputTab === "record" && (recordedAudioFile ? "Запись готова" : "Запись звука / встречи")}
                {inputTab === "text" && (manualText.trim() ? `${wordCount} слов` : "Вручную")}
              </p>
            </div>
          </button>

          {/* Step 2: Параметры */}
          <button
            type="button"
            disabled={!isStep1Complete}
            onClick={() => isStep1Complete && setCurrentStep(2)}
            className={`p-3 rounded-xl border flex items-center gap-2.5 text-left transition-all ${
              currentStep === 2
                ? "bg-indigo-950/60 border-indigo-500 ring-2 ring-indigo-500/30 text-indigo-200 shadow-md shadow-indigo-500/10 cursor-pointer"
                : isStep1Complete
                ? "bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700 cursor-pointer"
                : "bg-slate-950/40 border-slate-800/40 opacity-50 cursor-not-allowed text-slate-500"
            }`}
          >
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                currentStep === 2
                  ? "bg-indigo-600 text-white shadow-sm"
                  : isStep1Complete && isStep2Complete
                  ? "bg-indigo-600/30 border border-indigo-500/40 text-indigo-300"
                  : "bg-slate-800 border border-slate-700 text-slate-400"
              }`}
            >
              {!isStep1Complete ? <Lock className="w-3.5 h-3.5 text-slate-500" /> : "2"}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate text-white">Параметры</p>
              <p className="text-[11px] text-slate-400 truncate mt-0.5">
                {!isStep1Complete ? "Заблокирован" : title || "Название совещания"}
              </p>
            </div>
          </button>

          {/* Step 3: Транскрипт */}
          <button
            type="button"
            disabled={!isStep1Complete}
            onClick={() => isStep1Complete && setCurrentStep(3)}
            className={`p-3 rounded-xl border flex items-center gap-2.5 text-left transition-all ${
              currentStep === 3
                ? "bg-indigo-950/60 border-indigo-500 ring-2 ring-indigo-500/30 text-indigo-200 shadow-md shadow-indigo-500/10 cursor-pointer"
                : isStep1Complete
                ? "bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700 cursor-pointer"
                : "bg-slate-950/40 border-slate-800/40 opacity-50 cursor-not-allowed text-slate-500"
            }`}
          >
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                transcriptText.trim()
                  ? "bg-emerald-600/30 border border-emerald-500/40 text-emerald-300"
                  : isTranscribing
                  ? "bg-amber-600/30 border border-amber-500/40 text-amber-300"
                  : currentStep === 3
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-slate-800 border border-slate-700 text-slate-400"
              }`}
            >
              {!isStep1Complete ? (
                <Lock className="w-3.5 h-3.5 text-slate-500" />
              ) : transcriptText.trim() ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                "3"
              )}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate text-white">Транскрипт</p>
              <p className="text-[11px] text-slate-400 truncate mt-0.5">
                {!isStep1Complete
                  ? "Заблокирован"
                  : isTranscribing
                  ? "Распознавание..."
                  : transcriptText.trim()
                  ? `${wordCount} слов`
                  : "Ожидает распознавания"}
              </p>
            </div>
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm flex items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* STEP 1: Источник данных (активен по умолчанию) */}
      {currentStep === 1 && (
        <div className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Шаг 1. Источник данных совещания
              </span>
              <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setInputTab("file")}
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
                  onClick={() => setInputTab("record")}
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
                  onClick={() => setInputTab("text")}
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
              <AudioDropZone
                file={uploadedAudioFile}
                onFileSelect={(file) => {
                  setUploadedAudioFile(file);
                  if (!file) {
                    setDraftMeetingId(null);
                    setTranscriptText("");
                    setTranscribeError("");
                  }
                }}
              />
            )}

            {inputTab === "record" && (
              <AudioRecorder
                onAudioReady={(file) => {
                  setRecordedAudioFile(file);
                  if (!file) {
                    setDraftMeetingId(null);
                    setTranscriptText("");
                    setTranscribeError("");
                  }
                }}
              />
            )}

            {inputTab === "text" && (
              <div className="space-y-2">
                <textarea
                  rows={8}
                  placeholder="Вставьте расшифровку аудио, стенограмму или заметки с совещания..."
                  value={manualText}
                  onChange={(e) => {
                    setManualText(e.target.value);
                    setTranscriptText(e.target.value);
                  }}
                  className="w-full p-4 text-sm rounded-2xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors leading-relaxed font-sans"
                />
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>
                    Текст будет использован для формирования официального протокола совещания.
                  </span>
                  {manualText.trim() && (
                    <span className="text-indigo-300 font-medium">
                      {manualText.trim().split(/\s+/).length} слов • {manualText.length} симв.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Step 1 Footer: Status & Next Button */}
          <div className="pt-5 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs">
              {!isStep1Complete ? (
                <div className="flex items-center gap-2 text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3.5 py-2 rounded-xl">
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                  <span>
                    {inputTab === "file" && "Загрузите аудиофайл для перехода к параметрам (Шаг 2)"}
                    {inputTab === "record" && "Запишите звук встречи для перехода к параметрам (Шаг 2)"}
                    {inputTab === "text" && "Введите текст стенограммы или заметок для перехода к параметрам (Шаг 2)"}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-3.5 py-2 rounded-xl">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>
                    {inputTab === "file" &&
                      `Файл выбран: ${uploadedAudioFile?.name} (${formatFileSize(uploadedAudioFile?.size || 0)})`}
                    {inputTab === "record" &&
                      `Запись готова (${formatFileSize(recordedAudioFile?.size || 0)})`}
                    {inputTab === "text" &&
                      `Текст введен: ${wordCount} слов (${charCount} симв.)`}
                    {" — Шаг 1 пройден"}
                  </span>
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={!isStep1Complete}
              onClick={() => setCurrentStep(2)}
              className={`flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-xs transition-all ${
                isStep1Complete
                  ? "bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white shadow-lg shadow-indigo-600/25 active:scale-98 cursor-pointer"
                  : "bg-slate-800/60 text-slate-500 border border-slate-800 cursor-not-allowed"
              }`}
            >
              <span>Перейти к параметрам (Шаг 2)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: Параметры протокола (доступен только после прохождения Шага 1) */}
      {currentStep === 2 && (
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Шаг 2. Параметры протокола
            </span>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg text-xs bg-indigo-950/40 text-indigo-300 border border-indigo-500/30 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  Источник:{" "}
                  {inputTab === "file"
                    ? `Аудиофайл (${uploadedAudioFile?.name})`
                    : inputTab === "record"
                    ? "Голосовая запись"
                    : "Текст стенограммы"}
                </span>
              </span>
            </div>
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

          {/* Protocol template selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <LayoutTemplate className="w-3.5 h-3.5 text-violet-400" />
              <span>Шаблон протокола</span>
              {templatesError ? (
                <button
                  type="button"
                  onClick={loadWizardTemplates}
                  className="text-[11px] text-rose-300 underline font-normal"
                >
                  не удалось загрузить — повторить
                </button>
              ) : (
                templates.length === 0 && (
                  <span className="text-[11px] text-slate-500 font-normal">
                    — кастомных нет, загрузите в Настройки AI → Шаблоны
                  </span>
                )
              )}
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className="w-full py-2.5 px-3 text-sm rounded-xl bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-indigo-500 transition-colors font-medium"
            >
              <option value="">Стандартный протокол (по умолчанию)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} • {t.slots_count} полей
                </option>
              ))}
            </select>
            {selectedTemplateId && (
              <p className="text-[11px] text-violet-300/80">
                Значения полей шаблона сгенерирует LLM, экспорт DOCX — по вашему .docx.
              </p>
            )}
          </div>

          <ParticipantsInput
            participants={participants}
            onChange={setParticipants}
          />

          {/* Step 2 Footer Navigation */}
          <div className="pt-5 border-t border-slate-800 flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => setCurrentStep(1)}
              className="flex items-center gap-2 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Назад к источнику данных</span>
            </button>

            <button
              type="button"
              disabled={!isStep2Complete}
              onClick={() => setCurrentStep(3)}
              className="flex items-center gap-2 py-3 px-6 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-semibold text-xs transition-all shadow-lg shadow-indigo-500/25 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>Перейти к транскрипту (Шаг 3)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: Транскрипт (Стенограмма) */}
      {currentStep === 3 && (
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
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

                {(inputTab === "file" || inputTab === "record") && activeAudioFile && (
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
                  onClick={() => {
                    setTranscriptText("");
                    if (inputTab === "text") setManualText("");
                  }}
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
                  {activeAudioFile ? (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                          {activeAudioFile.type.startsWith("video/") ? (
                            <FileVideo className="w-5 h-5" />
                          ) : (
                            <FileAudio className="w-5 h-5" />
                          )}
                        </div>
                        <div>
                          <p className="font-semibold text-sm text-white truncate max-w-sm sm:max-w-md">
                            {activeAudioFile.name}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {formatFileSize(activeAudioFile.size)} •{" "}
                            {systemStatus?.whisper?.mode === "local"
                              ? `Локальный Whisper (${systemStatus?.whisper?.model || "small"})`
                              : `Внешний Whisper (${systemStatus?.whisper?.model || "custom"})`}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleTranscribeAudio}
                        className="flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-all shadow-md shadow-indigo-600/20 active:scale-95 shrink-0 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Распознать аудио (Whisper)</span>
                      </button>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center text-xs text-slate-400">
                      Сначала выберите файл или надиктуйте запись на Шаге 1.
                    </div>
                  )}

                  {!systemStatus?.whisper?.connected && (
                    <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                        <span>
                          {systemStatus?.whisper?.error ||
                            "Whisper STT не настроен. Установите локальную модель или укажите API-ключ в настройках."}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setView("settings")}
                        className="text-xs underline font-semibold text-amber-200 hover:text-white shrink-0"
                      >
                        Настроить
                      </button>
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
                      {transcribeStatus || "Идет локальное распознавание речи..."}
                    </h4>
                    <p className="text-xs text-slate-400 max-w-md mx-auto">
                      Локальная модель Whisper переводит речь в текст. После завершения распознавания текст появится ниже для проверки.
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
                onChange={(e) => {
                  setTranscriptText(e.target.value);
                  setManualText(e.target.value);
                }}
                placeholder="Вставьте расшифровку аудио, стенограмму или заметки с совещания..."
                className="w-full p-4 text-sm rounded-2xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors leading-relaxed font-sans"
              />
              <p className="text-xs text-slate-400">
                Текст готов к отправке в языковую модель для формирования официального протокола.
              </p>
            </div>
          )}

          {/* Step 3 Footer Navigation */}
          <div className="pt-5 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
            <button
              type="button"
              disabled={isSubmitting || isTranscribing}
              onClick={() => setCurrentStep(2)}
              className="flex items-center gap-2 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700 disabled:opacity-50"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Назад к параметрам</span>
            </button>

            <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
              {transcriptText.trim() && (
                <button
                  type="button"
                  disabled={isSubmitting || isTranscribing}
                  onClick={() => handleFinalSubmit(true)}
                  className="py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700 disabled:opacity-50 cursor-pointer"
                >
                  Сохранить только транскрипт
                </button>
              )}

              <button
                type="button"
                disabled={
                  isSubmitting ||
                  isTranscribing ||
                  (!transcriptText.trim() && !activeAudioFile)
                }
                onClick={() => {
                  if (!transcriptText.trim() && activeAudioFile) {
                    handleTranscribeAudio();
                  } else {
                    handleFinalSubmit(false);
                  }
                }}
                className="flex items-center justify-center gap-2.5 py-3 px-7 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-600 hover:from-indigo-500 hover:to-indigo-500 text-white font-semibold text-sm transition-all shadow-xl shadow-indigo-500/25 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
                ) : !transcriptText.trim() && activeAudioFile ? (
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
      )}
    </div>
  );
};
