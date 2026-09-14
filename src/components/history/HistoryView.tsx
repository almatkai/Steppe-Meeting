import React, { useEffect, useState } from "react";
import {
  Search,
  Calendar,
  Clock,
  Trash2,
  FileText,
  ChevronRight,
  Download,
  AlertCircle,
} from "lucide-react";
import { useMeetingStore } from "../../store/useMeetingStore";
import { api } from "../../services/api";
import { formatDate } from "../../lib/utils";
import { downloadMeetingProtocol } from "../../utils/fileDownload";

export const HistoryView: React.FC = () => {
  const { meetings, loadMeetings, selectMeeting, deleteMeeting, isLoading } = useMeetingStore();
  const [search, setSearch] = useState("");
  const [meetingToDelete, setMeetingToDelete] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings]);

  const filtered = meetings.filter((m) =>
    m.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Top Title & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">История совещаний</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Все протоколы и транскрипты сохраняются локально на вашем компьютере.
          </p>
        </div>

        <div className="relative w-full sm:w-80">
          <input
            type="text"
            placeholder="Поиск по названию..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full py-2 px-3 pl-9 text-xs rounded-xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
          />
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
        </div>
      </div>

      {/* Meetings List */}
      {filtered.length > 0 ? (
        <div className="space-y-3">
          {filtered.map((m) => (
            <div
              key={m.id}
              onClick={() => selectMeeting(m.id)}
              className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 hover:bg-slate-900/90 transition-all cursor-pointer flex items-center justify-between group shadow-sm"
            >
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-indigo-600/15 border border-indigo-500/25 flex items-center justify-center text-indigo-400 shrink-0 group-hover:scale-105 transition-transform">
                  <FileText className="w-5 h-5" />
                </div>

                <div className="min-w-0 space-y-1">
                  <h3 className="text-sm font-semibold text-white truncate max-w-lg group-hover:text-indigo-300 transition-colors">
                    {m.title}
                  </h3>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {formatDate(m.created_at)}
                    </span>
                    <span>•</span>
                    <span className="uppercase text-[10px] font-semibold text-indigo-300 font-mono">
                      {m.source_language}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {/* Status pill */}
                <span
                  className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
                    m.status === "completed"
                      ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                      : m.status === "generating" || m.status === "transcribing"
                      ? "bg-indigo-500/10 text-indigo-300 border border-indigo-500/20"
                      : m.status === "error"
                      ? "bg-rose-500/10 text-rose-300 border border-rose-500/20"
                      : "bg-slate-800 text-slate-400"
                  }`}
                >
                  {m.status === "completed"
                    ? "Готово"
                    : m.status === "generating"
                    ? "Генерация..."
                    : m.status === "transcribing"
                    ? "Транскрибация..."
                    : m.status === "error"
                    ? "Ошибка"
                    : "Черновик"}
                </span>

                {m.status === "completed" && (
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await downloadMeetingProtocol(m.id, "ru", m.title);
                    }}
                    className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    title="Скачать DOCX"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMeetingToDelete({ id: m.id, title: m.title });
                  }}
                  className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
                  title="Удалить"
                >
                  <Trash2 className="w-4 h-4" />
                </button>

                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white group-hover:translate-x-0.5 transition-all" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-12 rounded-2xl bg-slate-900/40 border border-slate-800/80 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center text-slate-400 mx-auto">
            <AlertCircle className="w-6 h-6" />
          </div>
          <p className="text-sm text-slate-300 font-medium">Совещаний пока нет</p>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Создайте первое совещание с помощью мастера, чтобы сформировать протокол и сохранить его в локальную базу.
          </p>
        </div>
      )}

      {/* Delete Meeting Modal */}
      {meetingToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-6 text-slate-100">
            <div className="flex items-center gap-3 mb-4 text-rose-400">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Удалить совещание?</h3>
                <p className="text-xs text-slate-400">Это действие нельзя отменить</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 mb-6 leading-relaxed">
              Вы уверены, что хотите удалить совещание <span className="font-semibold text-white">«{meetingToDelete.title}»</span>? Протокол, транскрипт и все связанные данные будут удалены из локальной базы.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setMeetingToDelete(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteMeeting(meetingToDelete.id);
                  setMeetingToDelete(null);
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-lg shadow-rose-600/25 transition-colors"
              >
                Удалить совещание
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
