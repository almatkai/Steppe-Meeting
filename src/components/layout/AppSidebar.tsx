import React, { useEffect } from "react";
import {
  FileText,
  Clock,
  Settings,
  PlusCircle,
  Cpu,
  Radio,
  CheckCircle2,
  XCircle,
  AlertCircle,
  MessageSquare,
} from "lucide-react";
import { SteppeLogo } from "../ui/SteppeIcon";
import { useMeetingStore } from "../../store/useMeetingStore";

export const AppSidebar: React.FC = () => {
  const { currentView, setView, systemStatus, checkStatus, meetings } = useMeetingStore();

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const ollamaOk = systemStatus?.ollama?.connected;
  const whisperOk = systemStatus?.whisper?.connected;

  return (
    <aside className="w-64 border-r border-slate-800 bg-slate-900/70 backdrop-blur-xl flex flex-col justify-between select-none">
      {/* Brand Header */}
      <div>
        <div className="h-16 flex items-center px-5 gap-3 border-b border-slate-800/80">
          <SteppeLogo className="w-9 h-9" />
          <div>
            <h1 className="font-semibold text-base tracking-tight text-white flex items-center gap-1.5">
              Steppe Meeting
            </h1>
            <p className="text-xs text-indigo-300 font-medium">Local AI Desktop</p>
          </div>
        </div>

        {/* Primary Action */}
        <div className="p-3">
          <button
            onClick={() => setView("wizard")}
            className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-medium text-sm transition-all shadow-sm ${
              currentView === "wizard"
                ? "bg-indigo-600 text-white shadow-indigo-600/30"
                : "bg-indigo-600/15 text-indigo-400 hover:bg-indigo-600 hover:text-white"
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
                ? "bg-slate-800 text-white font-medium"
                : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Clock className="w-4 h-4 text-slate-400" />
              <span>История</span>
            </div>
            {meetings.length > 0 && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                {meetings.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setView("chat")}
            className={`w-full flex items-center justify-between px-3.5 py-2 rounded-lg text-sm transition-colors ${
              currentView === "chat"
                ? "bg-slate-800 text-white font-medium"
                : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <MessageSquare className={`w-4 h-4 ${currentView === "chat" ? "text-indigo-400" : "text-slate-400"}`} />
              <span>AI Чат</span>
            </div>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              RAG
            </span>
          </button>

          <button
            onClick={() => setView("settings")}
            className={`w-full flex items-center gap-2.5 px-3.5 py-2 rounded-lg text-sm transition-colors ${
              currentView === "settings"
                ? "bg-slate-800 text-white font-medium"
                : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
            }`}
          >
            <Settings className="w-4 h-4 text-slate-400" />
            <span>Настройки AI</span>
          </button>
        </nav>
      </div>

      {/* System Status Indicators */}
      <div className="p-3 border-t border-slate-800/80 bg-slate-950/40">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-2">
          AI Сервисы
        </div>
        <div className="space-y-1.5">
          {/* LLM Status */}
          <div
            onClick={() => setView("settings")}
            className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800/80 hover:border-slate-700 cursor-pointer text-xs transition-colors"
          >
            <div className="flex items-center gap-2 truncate">
              <Cpu className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="text-slate-300 truncate font-mono">
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
            className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800/80 hover:border-slate-700 cursor-pointer text-xs transition-colors"
          >
            <div className="flex items-center gap-2 truncate">
              <Radio className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="text-slate-300 truncate font-mono">Whisper STT</span>
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
