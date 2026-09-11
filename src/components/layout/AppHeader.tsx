import React from "react";
import { useMeetingStore } from "../../store/useMeetingStore";
import { ArrowLeft, RefreshCw, Lock, Globe } from "lucide-react";

export const AppHeader: React.FC = () => {
  const { currentView, setView, activeMeeting, refreshActiveMeeting, isLoading, systemStatus } =
    useMeetingStore();

  const offline = systemStatus?.offline;

  const getTitle = () => {
    switch (currentView) {
      case "wizard":
        return "Новое совещание";
      case "meeting":
        return activeMeeting?.title || "Детали совещания";
      case "history":
        return "История совещаний";
      case "chat":
        return "AI Чат по материалам совещаний";
      case "settings":
        return "Настройки локальных моделей";
      default:
        return "Steppe Meeting";
    }
  };

  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur-md px-6 flex items-center justify-between select-none">
      <div className="flex items-center gap-3">
        {currentView === "meeting" && (
          <button
            onClick={() => setView("history")}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            title="Назад к истории"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <h2 className="text-base font-semibold text-white truncate max-w-xl">
          {getTitle()}
        </h2>
      </div>

      <div className="flex items-center gap-3">
        {/* Autonomy indicator. The app states its own network posture rather
            than asking anyone to take it on trust. */}
        {offline && (
          <span
            title={
              offline.offline
                ? `Распознавание: ${offline.stt.mode}\nМодель: ${offline.llm.endpoint}\nНи одного запроса во внешние сервисы.`
                : offline.violations.join("\n")
            }
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${
              offline.offline
                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"
                : "bg-rose-500/10 border-rose-500/25 text-rose-300"
            }`}
          >
            {offline.offline ? <Lock className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
            <span>{offline.offline ? "100% локально" : "Внешние запросы"}</span>
          </span>
        )}

        {currentView === "meeting" && (
          <button
            onClick={() => refreshActiveMeeting()}
            disabled={isLoading}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            title="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>
    </header>
  );
};
