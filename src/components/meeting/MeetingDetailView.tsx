import React, { useState, useEffect } from "react";
import {
  FileText,
  ListNumbers as ListOrdered,
  FileAudio,
  Play,
  ArrowCounterClockwise as RotateCcw,
  Warning as AlertTriangle,
  CircleNotch as Loader2,
  CheckCircle as CheckCircle2,
  ShareNetwork as Share2,
} from "@phosphor-icons/react";
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

  // New recordings open directly on their transcript while the server processes
  // the transcript. Do not switch tabs under the user as the status changes.
  useEffect(() => {
    if (activeMeeting) setTab(activeMeeting.status === "completed" ? "protocol" : "transcript");
  }, [activeMeeting?.id]);

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
      <div className="p-12 text-center text-neutral-400 text-sm">
        Совещание не выбрано.
      </div>
    );
  }

  const handleStartGenerate = async () => {
    try {
      setActionLoading(true);
      if (!activeMeeting.transcript_text?.trim() && activeMeeting.audio_filename) {
        await api.transcribe(activeMeeting.id);
      } else {
        await api.generate(activeMeeting.id);
      }
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
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-800/70 border border-neutral-700 text-neutral-300 text-xs font-medium">
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
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-800/70 border border-neutral-700 text-neutral-300 text-xs font-medium">
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
          <span className="px-2.5 py-1 rounded-full bg-neutral-800 text-neutral-300 text-xs font-medium">
            Черновик
          </span>
        );
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Top Banner */}
      <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold text-white tracking-tight">
                {activeMeeting.title}
              </h2>
              {getStatusBadge(activeMeeting.status)}
            </div>
            <p className="text-xs text-neutral-400">
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
                className="flex items-center gap-2 py-2 px-4 rounded-xl bg-white hover:bg-neutral-200 text-neutral-950 text-xs font-semibold transition-all shadow-md  active:scale-95 disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                <span>
                  {activeMeeting.status === "error"
                    ? activeMeeting.transcript_text?.trim() ? "Повторить генерацию" : "Повторить расшифровку"
                    : "Сгенерировать протокол"}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={`flex items-center gap-2 py-2 px-4 rounded-xl text-xs font-medium border transition-all ${
                isChatOpen
                  ? "bg-white border-neutral-500 text-neutral-950 shadow-md "
                  : "bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200"
              }`}
            >
              <SteppeIcon className="w-3.5 h-3.5 text-neutral-300" />
              <span>AI Ассистент</span>
            </button>
          </div>
        </div>

        {/* Live Processing Notice */}
        {(activeMeeting.status === "transcribing" || activeMeeting.status === "generating") && (
          <div className="p-4 rounded-xl bg-neutral-900/60 border border-neutral-700 flex items-center gap-3 text-xs text-neutral-200 animate-pulse">
            <Loader2 className="w-5 h-5 text-neutral-300 animate-spin shrink-0" />
            <div>
              <p className="font-semibold text-white">
                {activeMeeting.status === "transcribing"
                  ? "Идет локальное распознавание речи..."
                  : "Локальная модель формирует протокол..."}
              </p>
              <p className="text-neutral-400 mt-0.5">
                {activeMeeting.status === "transcribing"
                  ? "Аудиозапись передана в локальный Whisper STT. Сегменты речи будут доступны сразу после завершения."
                  : "Модель извлекает повестку, принятые решения, поручения и выполняет перевод на казахский язык."}
              </p>
            </div>
          </div>
        )}

        {activeMeeting.status === "draft" && activeMeeting.error_message?.startsWith("Запись сброшена.") && (
          <p className="text-xs text-neutral-400">{activeMeeting.error_message}</p>
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
        <div className="flex border-b border-neutral-800 gap-6 pt-2">
          <button
            type="button"
            onClick={() => setTab("protocol")}
            className={`pb-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              tab === "protocol"
                ? "border-neutral-500 text-white"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
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
                ? "border-neutral-500 text-white"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
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
                ? "border-neutral-500 text-white"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
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
