import React, { useState, useEffect, useRef } from "react";
import {
  FileText,
  ListNumbers as ListOrdered,
  FileAudio,
  Play,
  Square,
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
import { useGenerationStop } from "../../utils/useGenerationStop";
import type { GenerationRoute } from "../../types";
import { canChooseGenerationRoute } from "../../utils/generationRetry";
import { GenerationRoutePanel } from "./GenerationRoutePanel";

export const MeetingDetailView: React.FC = () => {
  const { activeMeeting, refreshActiveMeeting, stopGeneration } = useMeetingStore();
  const [tab, setTab] = useState<"protocol" | "summary" | "transcript">("protocol");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const identity = useRef({ id: activeMeeting?.id });
  if (identity.current.id !== activeMeeting?.id) identity.current = { id: activeMeeting?.id };
  const selection = identity.current;
  const inFlight = useRef(new Set<object>());
  const [action, setAction] = useState<{ selection: object | null; loading: boolean; error: string }>({ selection: null, loading: false, error: '' });
  const [routePanel, setRoutePanel] = useState<{ selection: object | null; open: boolean }>({ selection: null, open: false });
  const actionLoading = action.selection === selection && action.loading;
  const routePanelOpen = routePanel.selection === selection && routePanel.open;
  const { stopping, requestPending, requestStop, stopError, rerunRef } = useGenerationStop(activeMeeting, stopGeneration);

  // New recordings open directly on their transcript while the server processes
  // the transcript. Do not switch tabs under the user as the status changes.
  useEffect(() => {
    if (activeMeeting) setTab(activeMeeting.status === "completed" ? "protocol" : "transcript");
  }, [activeMeeting?.id]);

  // Poll when status is transcribing or generating
  useEffect(() => {
    if (!activeMeeting) return;
    if (stopping || activeMeeting.status === "transcribing" || activeMeeting.status === "generating" || activeMeeting.status === "cancelling") {
      const interval = setInterval(() => {
        refreshActiveMeeting();
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [activeMeeting?.id, activeMeeting?.status, stopping, refreshActiveMeeting]);

  if (!activeMeeting) {
    return (
      <div className="p-12 text-center text-neutral-400 text-sm">
        Совещание не выбрано.
      </div>
    );
  }

  const handleStartGenerate = async (route?: GenerationRoute) => {
    const id = activeMeeting.id;
    if (inFlight.current.has(selection)) throw new Error('Запуск уже выполняется');
    inFlight.current.add(selection);
    setAction({ selection, loading: true, error: '' });
    try {
      if (!activeMeeting.transcript_text?.trim() && activeMeeting.audio_filename) {
        await api.transcribe(id);
      } else {
        const result = await api.generate(id, route);
        // An accepted job must expose Stop/polling even if the following GET fails.
        if (identity.current === selection && useMeetingStore.getState().activeMeetingId === id) {
          useMeetingStore.setState(state => ({ activeMeeting: state.activeMeeting?.id === id ? {
            ...state.activeMeeting, status: result.status,
            generation_attempt: result.generation_attempt, error_message: '',
          } : state.activeMeeting }));
        }
      }
      if (identity.current === selection && useMeetingStore.getState().activeMeetingId === id) await refreshActiveMeeting();
    } catch (error) {
      if (identity.current === selection && !route) setAction({ selection, loading: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      inFlight.current.delete(selection);
      if (identity.current === selection) setAction(previous => ({ ...previous, loading: false }));
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
      case "cancelling":
      case "generating":
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-800/70 border border-neutral-700 text-neutral-300 text-xs font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{stopping ? "Останавливаем…" : "Генерация протокола..."}</span>
          </span>
        );
      case "cancelled":
        return <span className="px-2.5 py-1 rounded-full bg-neutral-800/70 border border-neutral-700 text-neutral-300 text-xs font-medium">Остановлено</span>;
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
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold text-white tracking-tight">
                {activeMeeting.title}
              </h2>
              {getStatusBadge(stopping ? "cancelling" : activeMeeting.status)}
            </div>
            <p className="text-xs text-neutral-400">
              Создано: {activeMeeting.created_at?.slice(0, 10)} • Язык:{" "}
              {activeMeeting.source_language.toUpperCase()}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!stopping && (activeMeeting.status === "transcribed" || activeMeeting.status === "error" || activeMeeting.status === "cancelled") && (
              <button
                type="button"
                ref={rerunRef}
                onClick={() => { void handleStartGenerate().catch(() => {}); }}
                disabled={actionLoading}
                className={`flex items-center gap-2 py-2 px-4 rounded-xl text-xs font-semibold transition-all disabled:opacity-50 ${routePanelOpen ? 'bg-neutral-800 border border-neutral-700 text-neutral-200 hover:bg-neutral-700' : 'bg-white hover:bg-neutral-200 text-neutral-950 shadow-md active:scale-95'}`}
              >
                {actionLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                <span>
                  {activeMeeting.status === "cancelled" ? "Сформировать протокол заново" : activeMeeting.status === "error"
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

        {/* Transcribing keeps its existing progress presentation. */}
        {activeMeeting.status === "transcribing" && (
          <div className="p-4 rounded-xl bg-neutral-900/60 border border-neutral-700 flex items-center gap-3 text-xs text-neutral-200 animate-pulse">
            <Loader2 className="w-5 h-5 text-neutral-300 animate-spin shrink-0" />
            <div>
              <p className="font-semibold text-white">Идет локальное распознавание речи...</p>
              <p className="text-neutral-400 mt-0.5">Аудиозапись передана в локальный Whisper STT. Сегменты речи будут доступны сразу после завершения.</p>
            </div>
          </div>
        )}

        {(stopping || activeMeeting.status === "generating") && (
          <div role="status" aria-live="polite" aria-busy={stopping}
            className="p-4 rounded-xl bg-neutral-900/60 border border-neutral-700 flex items-center justify-between gap-3 text-xs text-neutral-200">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-neutral-300 animate-spin shrink-0" />
              <div>
                <p className="font-semibold text-white">{stopping ? "Останавливаем генерацию…" : "Локальная модель формирует протокол..."}</p>
                <p className="text-neutral-400 mt-0.5">Модель извлекает повестку, принятые решения, поручения и выполняет перевод на казахский язык.</p>
              </div>
            </div>
            <button type="button" onClick={requestStop} disabled={stopping} aria-busy={stopping}
              className="shrink-0 flex items-center gap-1.5 border border-neutral-600 text-neutral-200 hover:bg-neutral-800 rounded-lg px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-60">
              {stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
              {stopping ? "Останавливаем…" : "Остановить"}
            </button>
          </div>
        )}
        {stopError && (
          <div role="status" aria-live="polite" className="flex items-center gap-3 text-xs text-neutral-300">
            <span>Не удалось остановить. {stopError}</span>
            <button type="button" onClick={requestStop} disabled={requestPending}
              className="underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">Повторить</button>
          </div>
        )}
        {activeMeeting.status === "cancelled" && !stopping && (
          <p role="status" aria-live="polite" className="text-xs text-neutral-400">Генерация протокола остановлена.</p>
        )}

        {activeMeeting.status === "draft" && activeMeeting.error_message?.startsWith("Запись сброшена.") && (
          <p className="text-xs text-neutral-400">{activeMeeting.error_message}</p>
        )}

        {/* Error Notice */}
        {activeMeeting.status === "error" && activeMeeting.error_message && !stopError && (
          <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-500/30 text-xs text-rose-300 space-y-1">
            <p className="font-semibold text-white flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <span>Ошибка во время обработки</span>
            </p>
            <p className="font-mono text-[11px] break-all">{activeMeeting.error_message}</p>
          </div>
        )}

        {action.selection === selection && action.error && <p role="alert" className="text-xs text-rose-300">Не удалось запустить: {action.error}</p>}
        {canChooseGenerationRoute(activeMeeting.status, activeMeeting.transcript_text || '', stopping) && (
          <GenerationRoutePanel key={activeMeeting.id} meetingId={activeMeeting.id} lastAttempt={activeMeeting.generation_attempt}
            busy={actionLoading} onStart={handleStartGenerate}
            onOpenChange={open => { if (identity.current === selection) setRoutePanel({ selection, open }); }}
            onSettings={() => useMeetingStore.getState().setView('settings')} />
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
