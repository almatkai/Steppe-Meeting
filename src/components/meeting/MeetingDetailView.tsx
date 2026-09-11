import React, { useState, useEffect } from "react";
import {
  FileText,
  ListOrdered,
  FileAudio,
  Play,
  RotateCcw,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Share2,
  Download,
  CheckSquare,
} from "lucide-react";
import { SteppeIcon } from "../ui/SteppeIcon";
import { useMeetingStore } from "../../store/useMeetingStore";
import { TranscriptView } from "./TranscriptView";
import { ProtocolView } from "./ProtocolView";
import { SummaryView } from "./SummaryView";
import { ActionItemsView } from "./ActionItemsView";
import { AiChatDrawer } from "./AiChatDrawer";
import { api } from "../../services/api";

/** The formats the track's must-have list asks for, plus a calendar file. */
const EXPORT_FORMATS = [
  { id: "json" as const, label: "JSON", hint: "Полные структурированные данные встречи" },
  { id: "csv" as const, label: "CSV", hint: "Таблица поручений для Excel" },
  { id: "ics" as const, label: "ICS", hint: "Поручения со сроками в календарь" },
];

export const MeetingDetailView: React.FC = () => {
  const { activeMeeting, refreshActiveMeeting } = useMeetingStore();
  const [tab, setTab] = useState<"protocol" | "summary" | "tasks" | "transcript">("protocol");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // If meeting was just transcribed and protocol is not generated yet, open transcript tab
  useEffect(() => {
    if (activeMeeting?.status === "transcribed" && !activeMeeting.protocol_ru?.topics?.length) {
      setTab("transcript");
    }
  }, [activeMeeting?.id, activeMeeting?.status]);

  // Poll when status is transcribing or generating
  useEffect(() => {
    if (!activeMeeting) return;
    if (activeMeeting.status === "transcribing" || activeMeeting.status === "generating") {
      const interval = setInterval(() => {
        refreshActiveMeeting();
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [activeMeeting?.status, refreshActiveMeeting]);

  if (!activeMeeting) {
    return (
      <div className="p-12 text-center text-slate-400 text-sm">
        Совещание не выбрано.
      </div>
    );
  }

  const handleStartGenerate = async () => {
    try {
      setActionLoading(true);
      await api.generate(activeMeeting.id);
      await refreshActiveMeeting();
    } catch (e: any) {
      alert("Ошибка запуска генерации: " + e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "transcribing":
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Транскрибация аудио...</span>
          </span>
        );
      case "generating":
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Генерация протокола...</span>
          </span>
        );
      case "completed":
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-medium">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Готово</span>
          </span>
        );
      case "transcribed":
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs font-medium">
            <span>Транскрибировано</span>
          </span>
        );
      case "error":
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-medium">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Ошибка обработки</span>
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 text-xs font-medium">
            Черновик
          </span>
        );
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Top Banner */}
      <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold text-white tracking-tight">
                {activeMeeting.title}
              </h2>
              {getStatusBadge(activeMeeting.status)}
            </div>
            <p className="text-xs text-slate-400">
              Создано: {activeMeeting.created_at?.slice(0, 10)} • Язык:{" "}
              {activeMeeting.source_language.toUpperCase()}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {(activeMeeting.status === "transcribed" || activeMeeting.status === "error") && (
              <button
                type="button"
                onClick={handleStartGenerate}
                disabled={actionLoading}
                className="flex items-center gap-2 py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-md shadow-indigo-600/20 active:scale-95 disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                <span>
                  {activeMeeting.status === "error"
                    ? "Повторить генерацию"
                    : "Сгенерировать протокол"}
                </span>
              </button>
            )}

            {activeMeeting.status === "completed" && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-500 hidden sm:inline">Экспорт:</span>
                {EXPORT_FORMATS.map((format) => (
                  <button
                    key={format.id}
                    type="button"
                    title={format.hint}
                    onClick={() =>
                      window.open(api.getExportUrl(activeMeeting.id, format.id), "_blank")
                    }
                    className="flex items-center gap-1 py-2 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-slate-200 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    <span>{format.label}</span>
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={`flex items-center gap-2 py-2 px-4 rounded-xl text-xs font-medium border transition-all ${
                isChatOpen
                  ? "bg-indigo-600 border-indigo-500 text-white shadow-md shadow-indigo-600/20"
                  : "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200"
              }`}
            >
              <SteppeIcon className="w-3.5 h-3.5 text-indigo-400" />
              <span>AI Ассистент</span>
            </button>
          </div>
        </div>

        {/* Live Processing Notice with real progress */}
        {(activeMeeting.status === "transcribing" || activeMeeting.status === "generating") && (
          <div className="p-4 rounded-xl bg-indigo-950/30 border border-indigo-500/30 space-y-3">
            <div className="flex items-center gap-3 text-xs text-indigo-200">
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-white">
                  {activeMeeting.status === "transcribing"
                    ? "Идет распознавание речи"
                    : "Модель формирует протокол"}
                </p>
                <p className="text-indigo-300/80 mt-0.5">
                  {activeMeeting.progress_label ||
                    (activeMeeting.status === "transcribing"
                      ? "Аудиозапись передана в Whisper STT."
                      : "Модель извлекает повестку, решения, поручения и переводит на казахский.")}
                </p>
              </div>
              <span className="text-sm font-bold text-indigo-300 font-mono shrink-0 tabular-nums">
                {Math.round(activeMeeting.progress ?? 0)}%
              </span>
            </div>

            <div
              className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden"
              role="progressbar"
              aria-valuenow={Math.round(activeMeeting.progress ?? 0)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-700 ease-out"
                style={{ width: `${Math.max(2, Math.min(100, activeMeeting.progress ?? 0))}%` }}
              />
            </div>
          </div>
        )}

        {/* Error Notice */}
        {activeMeeting.status === "error" && activeMeeting.error_message && (
          <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-500/30 text-xs text-rose-300 space-y-1">
            <p className="font-semibold text-white flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <span>Ошибка во время обработки</span>
            </p>
            <p className="font-mono text-[11px] break-all">{activeMeeting.error_message}</p>
          </div>
        )}

        {/* Main Tabs */}
        <div className="flex border-b border-slate-800 gap-6 pt-2">
          <button
            type="button"
            onClick={() => setTab("protocol")}
            className={`pb-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              tab === "protocol"
                ? "border-indigo-500 text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Протокол совещания (Хаттама)</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("summary")}
            className={`pb-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              tab === "summary"
                ? "border-indigo-500 text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <ListOrdered className="w-4 h-4" />
            <span>Краткое резюме и задачи</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("tasks")}
            className={`pb-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              tab === "tasks"
                ? "border-indigo-500 text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <CheckSquare className="w-4 h-4" />
            <span>Поручения</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("transcript")}
            className={`pb-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              tab === "transcript"
                ? "border-indigo-500 text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <FileAudio className="w-4 h-4" />
            <span>Стенограмма (Транскрипт)</span>
          </button>
        </div>
      </div>

      {/* Tab Panels */}
      <div>
        {tab === "protocol" && (
          <ProtocolView
            meetingId={activeMeeting.id}
            protocolRu={activeMeeting.protocol_ru}
            protocolKz={activeMeeting.protocol_kz}
            meetingTitle={activeMeeting.title}
            createdAt={activeMeeting.created_at}
            agendaText={activeMeeting.agenda}
          />
        )}

        {tab === "summary" && (
          <SummaryView
            summaryRu={activeMeeting.summary_ru}
            summaryKz={activeMeeting.summary_kz}
          />
        )}

        {tab === "tasks" && <ActionItemsView meetingId={activeMeeting.id} />}

        {tab === "transcript" && (
          <TranscriptView
            meetingId={activeMeeting.id}
            transcriptText={activeMeeting.transcript_text}
            segments={activeMeeting.transcript_segments}
            audioFilename={activeMeeting.audio_filename}
            speakerSource={activeMeeting.speaker_source}
            onSpeakersChanged={refreshActiveMeeting}
          />
        )}
      </div>

      {/* AI Assistant Drawer */}
      <AiChatDrawer
        meetingId={activeMeeting.id}
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        contextProtocol={JSON.stringify(activeMeeting.protocol_ru)}
        contextSummary={JSON.stringify(activeMeeting.summary_ru)}
      />
    </div>
  );
};
