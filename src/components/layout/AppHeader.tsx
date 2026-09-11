import React from "react";
import { useMeetingStore } from "../../store/useMeetingStore";
import { ArrowLeft, RefreshCw } from "lucide-react";

export const AppHeader: React.FC = () => {
  const { currentView, setView, activeMeeting, refreshActiveMeeting, isLoading } = useMeetingStore();

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
