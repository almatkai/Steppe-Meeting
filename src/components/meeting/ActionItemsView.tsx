import React, { useEffect, useState } from "react";
import { CheckSquare, User, CalendarClock, Download, Loader2, AlertCircle } from "lucide-react";
import { api } from "../../services/api";
import type { ActionItem } from "../../types";

interface ActionItemsViewProps {
  meetingId: string;
}

const PRIORITY_STYLES: Record<string, string> = {
  высокий: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  средний: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  низкий: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

/**
 * Action items as a standalone table. They were previously buried inside the
 * summary view, which made the single most actionable output of the whole app
 * the hardest thing to find.
 */
export const ActionItemsView: React.FC<ActionItemsViewProps> = ({ meetingId }) => {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [withDates, setWithDates] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setIsLoading(true);
        setError("");
        const data = await api.getActionItems(meetingId);
        if (cancelled) return;
        setItems(data.items);
        setWithDates(data.with_parsable_deadline);
      } catch (e: any) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  if (isLoading) {
    return (
      <div className="p-10 text-center text-slate-400 text-xs flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Загружаю поручения...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
        <span>{error}</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="p-10 rounded-2xl bg-slate-900/40 border border-slate-800 text-center space-y-1">
        <CheckSquare className="w-8 h-8 text-slate-600 mx-auto" />
        <p className="text-sm text-white font-medium">Поручений не найдено</p>
        <p className="text-xs text-slate-400">
          Модель не нашла в стенограмме явных задач с исполнителями.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>
            Всего поручений: <strong className="text-white">{items.length}</strong>
          </span>
          <span className="text-slate-600">•</span>
          <span>
            Со сроком для календаря: <strong className="text-white">{withDates}</strong>
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => window.open(api.getExportUrl(meetingId, "csv"), "_blank")}
            className="flex items-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-slate-200 transition-colors"
          >
            <Download className="w-3 h-3" />
            <span>Таблица CSV</span>
          </button>
          <button
            type="button"
            disabled={withDates === 0}
            title={
              withDates === 0
                ? "Ни у одного поручения нет распознаваемого срока"
                : "Скачать .ics и открыть в календаре"
            }
            onClick={() => window.open(api.getExportUrl(meetingId, "ics"), "_blank")}
            className="flex items-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-slate-200 transition-colors disabled:opacity-40"
          >
            <CalendarClock className="w-3 h-3" />
            <span>В календарь</span>
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full text-xs min-w-[640px]">
          <thead className="bg-slate-900/80 text-slate-400">
            <tr>
              <th className="text-left font-medium py-2.5 px-3">Задача</th>
              <th className="text-left font-medium py-2.5 px-3 w-40">Ответственный</th>
              <th className="text-left font-medium py-2.5 px-3 w-36">Срок</th>
              <th className="text-left font-medium py-2.5 px-3 w-28">Приоритет</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr
                key={`${item.task}-${index}`}
                className="border-t border-slate-800/80 hover:bg-slate-900/40 transition-colors"
              >
                <td className="py-2.5 px-3 text-slate-200 align-top">
                  {item.task}
                  {item.topic && (
                    <span className="block text-[10px] text-slate-500 mt-0.5">{item.topic}</span>
                  )}
                </td>
                <td className="py-2.5 px-3 align-top">
                  {item.assignee ? (
                    <span className="flex items-center gap-1 text-slate-300">
                      <User className="w-3 h-3 text-indigo-400 shrink-0" />
                      {item.assignee}
                    </span>
                  ) : (
                    <span className="text-slate-600">не назначен</span>
                  )}
                </td>
                <td className="py-2.5 px-3 align-top text-slate-300">
                  {item.deadline || <span className="text-slate-600">не указан</span>}
                </td>
                <td className="py-2.5 px-3 align-top">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-semibold ${
                      PRIORITY_STYLES[item.priority] || PRIORITY_STYLES["средний"]
                    }`}
                  >
                    {item.priority || "средний"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
