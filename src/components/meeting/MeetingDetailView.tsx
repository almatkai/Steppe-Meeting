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
} from "lucide-react";
import { SteppeIcon } from "../ui/SteppeIcon";
import { useMeetingStore } from "../../store/useMeetingStore";
import { TranscriptView } from "./TranscriptView";
import { ProtocolView } from "./ProtocolView";
import { SummaryView } from "./SummaryView";
import { AiChatDrawer } from "./AiChatDrawer";
import { api } from "../../services/api";

export const MeetingDetailView: React.FC = () => {
  const { activeMeeting, refreshActiveMeeting } = useMeetingStore();
  const [tab, setTab] = useState<"protocol" | "summary" | "transcript">("protocol");
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

        {/* Live Processing Notice */}
        {(activeMeeting.status === "transcribing" || activeMeeting.status === "generating") && (
          <div className="p-4 rounded-xl bg-indigo-950/30 border border-indigo-500/30 flex items-center gap-3 text-xs text-indigo-200 animate-pulse">
            <Loader2 className="w-5 h-5 text-indigo-400 animate-spin shrink-0" />
            <div>
              <p className="font-semibold text-white">
                {activeMeeting.status === "transcribing"
                  ? "Идет локальное распознавание речи..."
                  : "Локальная модель формирует протокол..."}
              </p>
              <p className="text-indigo-300/80 mt-0.5">
                {activeMeeting.status === "transcribing"
                  ? "Аудиозапись передана в локальный Whisper STT. Сегменты речи будут доступны сразу после завершения."
                  : "Модель извлекает повестку, принятые решения, поручения и выполняет перевод на казахский язык."}
              </p>
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

        {tab === "transcript" && (
          <TranscriptView
            transcriptText={activeMeeting.transcript_text}
            segments={activeMeeting.transcript_segments}
            audioFilename={activeMeeting.audio_filename}
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
