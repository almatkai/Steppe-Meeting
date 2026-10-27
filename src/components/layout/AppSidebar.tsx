import React, { useEffect } from "react";
import {
  FileText,
  Clock,
  GearSix as Settings,
  PlusCircle,
  Cpu,
  Broadcast as Radio,
  CheckCircle as CheckCircle2,
  XCircle,
  WarningCircle as AlertCircle,
  ChatCircle as MessageSquare,
  CornersIn,
} from "@phosphor-icons/react";
import { SteppeLogo } from "../ui/SteppeIcon";
import { useMeetingStore } from "../../store/useMeetingStore";

export const AppSidebar: React.FC = () => {
  const { currentView, setView, systemStatus, checkStatus, meetings, setMiniMode } = useMeetingStore();

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const ollamaOk = systemStatus?.ollama?.connected;
  const whisperOk = systemStatus?.whisper?.connected;

  return (
    <aside className="w-64 border-r border-neutral-800 bg-neutral-900/70 backdrop-blur-xl flex flex-col justify-between select-none">
      {/* Brand Header */}
      <div>
        <div className="h-16 flex items-center px-5 gap-3 border-b border-neutral-800/80">
          <SteppeLogo className="w-9 h-9" />
          <div>
            <h1 className="font-semibold text-base tracking-tight text-white flex items-center gap-1.5">
              Steppe Meeting
            </h1>
            <p className="text-xs text-neutral-300 font-medium">Local AI Desktop</p>
          </div>
        </div>

        {/* Primary Action */}
        <div className="p-3">
          <button
            onClick={() => setView("wizard")}
            className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-medium text-sm transition-all shadow-sm ${
              currentView === "wizard"
                ? "bg-white text-neutral-950 "
                : "bg-neutral-800/70 text-neutral-300 hover:bg-neutral-200 hover:text-neutral-950"
            }`}
          >
            <PlusCircle className="w-4 h-4" />
            <span>Новое совещание</span>
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="px-3 space-y-1 mt-1">
          <button
            onClick={() => setView("history")}
            className={`w-full flex items-center justify-between px-3.5 py-2 rounded-lg text-sm transition-colors ${
              currentView === "history" || currentView === "meeting"
                ? "bg-neutral-800 text-white font-medium"
                : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Clock className="w-4 h-4 text-neutral-400" />
              <span>История</span>
            </div>
            {meetings.length > 0 && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                {meetings.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setView("chat")}
            className={`w-full flex items-center justify-between px-3.5 py-2 rounded-lg text-sm transition-colors ${
              currentView === "chat"
                ? "bg-neutral-800 text-white font-medium"
                : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <MessageSquare className={`w-4 h-4 ${currentView === "chat" ? "text-neutral-300" : "text-neutral-400"}`} />
              <span>AI Чат</span>
            </div>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-neutral-800/70 text-neutral-300 border border-neutral-700">
              RAG
            </span>
          </button>

          <button
            onClick={() => setView("settings")}
            className={`w-full flex items-center gap-2.5 px-3.5 py-2 rounded-lg text-sm transition-colors ${
              currentView === "settings"
                ? "bg-neutral-800 text-white font-medium"
                : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
            }`}
          >
            <Settings className="w-4 h-4 text-neutral-400" />
            <span>Настройки AI</span>
          </button>

          {/* Mini Mode Quick Action */}
          <button
            onClick={() => setMiniMode(true)}
            className="w-full flex items-center justify-between px-3.5 py-2 rounded-lg text-sm text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200 transition-colors mt-2"
          >
            <div className="flex items-center gap-2.5">
              <CornersIn className="w-4 h-4 text-indigo-400" />
              <span>Mini Mode</span>
            </div>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
              HUD
            </span>
          </button>
        </nav>
      </div>

      {/* System Status Indicators */}
      <div className="p-3 border-t border-neutral-800/80 bg-neutral-950/40">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 px-1 mb-2">
          AI Сервисы
        </div>
        <div className="space-y-1.5">
          {/* LLM Status */}
          <div
            onClick={() => setView("settings")}
            className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-neutral-900 border border-neutral-800/80 hover:border-neutral-700 cursor-pointer text-xs transition-colors"
          >
            <div className="flex items-center gap-2 truncate">
              <Cpu className="w-3.5 h-3.5 text-neutral-300 shrink-0" />
              <span className="text-neutral-300 truncate font-mono">
                {systemStatus?.ollama?.model || "LLM"}
              </span>
            </div>
            {ollamaOk ? (
              <div className="flex items-center gap-1 text-emerald-400 font-medium shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span>Active</span>
              </div>
            ) : systemStatus?.ollama?.service_online && !systemStatus?.ollama?.model_ready ? (
              <div
                className="flex items-center gap-1 text-amber-400 font-medium shrink-0"
                title={systemStatus?.ollama?.error || "Модель не скачана"}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                <span>Нет модели</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-rose-400 font-medium shrink-0">
                <XCircle className="w-3 h-3" />
                <span>Offline</span>
              </div>
            )}
          </div>

          {/* Whisper Status */}
          <div
            onClick={() => setView("settings")}
            className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-neutral-900 border border-neutral-800/80 hover:border-neutral-700 cursor-pointer text-xs transition-colors"
          >
            <div className="flex items-center gap-2 truncate">
              <Radio className="w-3.5 h-3.5 text-neutral-300 shrink-0" />
              <span className="text-neutral-300 truncate font-mono text-[11px]">
                {systemStatus?.whisper?.mode === "local"
                  ? `STT (${systemStatus?.whisper?.model || "local"})`
                  : "Whisper STT"}
              </span>
            </div>
            {whisperOk ? (
              <div className="flex items-center gap-1 text-emerald-400 font-medium shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span>Ready</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-rose-400 font-medium shrink-0">
                <XCircle className="w-3 h-3" />
                <span>Offline</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
