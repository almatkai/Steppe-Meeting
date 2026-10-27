import React from "react";
import { useMeetingStore } from "../../store/useMeetingStore";
import {
  ArrowLeft,
  ArrowsClockwise as RefreshCw,
  CornersIn,
} from "@phosphor-icons/react";

export const AppHeader: React.FC = () => {
  const { currentView, setView, activeMeeting, refreshActiveMeeting, isLoading, setMiniMode } = useMeetingStore();

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
    <header className="h-16 border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-md px-6 flex items-center justify-between select-none">
      <div className="flex items-center gap-3">
        {currentView === "meeting" && (
          <button
            onClick={() => setView("history")}
            className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
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
            className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
            title="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}

        <button
          onClick={() => setMiniMode(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-800/80 hover:bg-neutral-700/80 text-neutral-300 hover:text-white border border-neutral-700/70 text-xs font-medium transition-all shadow-sm active:scale-95"
          title="Переключиться в компактный плавающий виджет Mini Mode"
        >
          <CornersIn className="w-4 h-4 text-indigo-400" />
          <span>Mini Mode</span>
        </button>
      </div>
    </header>
  );
};
