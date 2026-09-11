import React, { useState } from "react";
import {
  Download,
  Copy,
  Check,
  Edit3,
  Calendar,
  Users,
  CheckSquare,
  Wand2,
  X,
  Loader2,
} from "lucide-react";
import { SteppeIcon } from "../ui/SteppeIcon";
import type { ProtocolData } from "../../types";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import { downloadMeetingProtocol } from "../../utils/fileDownload";

interface ProtocolViewProps {
  meetingId: string;
  protocolRu: ProtocolData;
  protocolKz: ProtocolData;
  meetingTitle: string;
  createdAt: string;
  agendaText: string;
  onUpdateProtocol?: (lang: "ru" | "kz", updated: ProtocolData) => void;
}

export const ProtocolView: React.FC<ProtocolViewProps> = ({
  meetingId,
  protocolRu,
  protocolKz,
  meetingTitle,
  createdAt,
  agendaText,
  onUpdateProtocol,
}) => {
  const [lang, setLang] = useState<"ru" | "kz">("ru");
  const [copied, setCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Floating AI edit toolbar state
  const [selectedText, setSelectedText] = useState("");
  const [selectionRange, setSelectionRange] = useState<{ x: number; y: number } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editResult, setEditResult] = useState("");

  const activeProtocol = lang === "kz" ? protocolKz : protocolRu;
  const { refreshActiveMeeting } = useMeetingStore();

  const handleMouseUp = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      // Don't close if user clicked inside the toolbar
      return;
    }
    const text = selection.toString().trim();
    if (text.length > 5) {
      setSelectedText(text);
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setSelectionRange({
        x: Math.min(Math.max(rect.left, 20), window.innerWidth - 320),
        y: rect.bottom + window.scrollY + 8,
      });
    }
  };

  const closeToolbar = () => {
    setSelectedText("");
    setSelectionRange(null);
    setInstruction("");
    setEditResult("");
  };

  const handleApplyAiEdit = async () => {
    if (!instruction.trim() || !selectedText) return;
    try {
      setIsEditing(true);
      const result = await api.editText(selectedText, instruction);
      setEditResult(result);
    } catch (e: any) {
      alert("Ошибка AI редактирования: " + e.message);
    } finally {
      setIsEditing(false);
    }
  };

  const handleApplyEditToDocument = async () => {
    if (!selectedText || !editResult) {
      closeToolbar();
      return;
    }
    try {
      const activeCopy = JSON.parse(JSON.stringify(activeProtocol || {}));
      let jsonStr = JSON.stringify(activeCopy);
      if (jsonStr.includes(selectedText)) {
        jsonStr = jsonStr.replaceAll(selectedText, editResult);
        const updatedProtocol = JSON.parse(jsonStr);
        if (onUpdateProtocol) {
          onUpdateProtocol(lang, updatedProtocol);
        }
        await api.updateMeeting(meetingId, {
          [lang === "kz" ? "protocol_kz" : "protocol_ru"]: updatedProtocol,
        });
        await refreshActiveMeeting();
      }
    } catch (err: any) {
      console.error("Failed to apply inline edit to document", err);
      alert("Не удалось применить правку: " + (err.message || String(err)));
    } finally {
      closeToolbar();
    }
  };

  const handleCopy = () => {
    const text = JSON.stringify(activeProtocol, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadDocx = async () => {
    try {
      setIsExporting(true);
      await downloadMeetingProtocol(meetingId, lang, meetingTitle);
    } catch {
      // Toast notification already shown
    } finally {
      setIsExporting(false);
    }
  };

  const rawTopics = (activeProtocol as any)?.agenda_items || activeProtocol?.topics || [];
  const topics = rawTopics.map((t: any) => ({
    topic_name: t.topic || t.topic_name || "Вопрос",
    discussion: t.speaker || t.discussion || "",
    decisions: t.decisions || [],
  }));
  const participants = activeProtocol?.participants || [];

  return (
    <div className="space-y-6 relative" onMouseUp={handleMouseUp}>
      {/* Action Header */}
      <div className="flex items-center justify-between gap-4">
        {/* Language Tabs */}
        <div className="flex items-center p-1 rounded-xl bg-slate-900 border border-slate-800">
          <button
            type="button"
            onClick={() => setLang("ru")}
            className={`py-1.5 px-4 rounded-lg text-xs font-semibold transition-all ${
              lang === "ru"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Русский вариант (RU)
          </button>
          <button
            type="button"
            onClick={() => setLang("kz")}
            className={`py-1.5 px-4 rounded-lg text-xs font-semibold transition-all ${
              lang === "kz"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Қазақша нұсқасы (KZ)
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={downloadDocx}
            disabled={isExporting}
            className="flex items-center gap-1.5 py-2 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-medium transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
          >
            {isExporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span>{isExporting ? "Экспорт..." : "Скачать DOCX"}</span>
          </button>

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? "Скопировано" : "Копировать"}</span>
          </button>
        </div>
      </div>

      {/* Official Protocol Paper Card */}
      <div className="p-8 sm:p-12 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-2xl text-slate-200 select-text font-serif leading-relaxed">
        {/* Document Header */}
        <div className="text-center pb-8 border-b border-slate-800 space-y-2 font-sans">
          <p className="text-xs uppercase tracking-widest text-indigo-400 font-semibold">
            {lang === "kz" ? "ХАТТАМА" : "ПРОТОКОЛ ЗАСЕДАНИЯ"}
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white uppercase tracking-tight">
            {meetingTitle}
          </h1>
          <div className="flex items-center justify-center gap-6 text-xs text-slate-400 pt-2">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              {createdAt ? createdAt.slice(0, 10) : "—"}
            </span>
            <span>г. Астана / Астана қаласы</span>
          </div>
        </div>

        {/* Agenda Section */}
        <div className="py-6 border-b border-slate-800/80 space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-indigo-300 font-sans flex items-center gap-1.5">
            <span>{lang === "kz" ? "Күн тәртібі:" : "Повестка дня:"}</span>
          </h2>
          <p className="text-sm text-slate-300 font-sans leading-relaxed whitespace-pre-wrap">
            {agendaText || activeProtocol?.metadata?.agenda || "Вопросы рабочего совещания"}
          </p>
        </div>

        {/* Participants Section */}
        <div className="py-6 border-b border-slate-800/80 space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-indigo-300 font-sans flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            <span>{lang === "kz" ? "Қатысқандар:" : "Присутствовали:"}</span>
          </h2>
          {participants.length > 0 ? (
            <ul className="text-sm font-sans space-y-1 text-slate-300">
              {participants.map((p, idx) => (
                <li key={idx}>
                  • {typeof p === "string" ? p : `${p.name}${p.role || p.position ? ` (${p.role || p.position})` : ""}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-400 font-sans italic">
              Согласно утвержденному списку участников
            </p>
          )}
        </div>

        {/* Topics & Decisions */}
        <div className="py-6 space-y-8 font-sans">
          <h2 className="text-xs font-bold uppercase tracking-wider text-indigo-300 font-sans flex items-center gap-1.5">
            <CheckSquare className="w-3.5 h-3.5" />
            <span>{lang === "kz" ? "Шешімдер мен тапсырмалар:" : "Решения и поручения:"}</span>
          </h2>

          {topics.length > 0 ? (
            topics.map((t: any, idx: number) => (
              <div key={idx} className="space-y-3 bg-slate-950/40 p-5 rounded-xl border border-slate-800/70">
                <h3 className="text-sm font-semibold text-white flex items-baseline gap-2">
                  <span className="text-indigo-400 font-mono">{idx + 1}.</span>
                  <span>{t.topic_name}</span>
                </h3>

                {t.discussion && (
                  <p className="text-xs text-slate-400 italic pl-5 leading-relaxed">
                    Выступили: {t.discussion}
                  </p>
                )}

                <div className="pl-5 space-y-2 pt-1">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {lang === "kz" ? "Қаулы етілді:" : "Постановили:"}
                  </div>
                  <ul className="space-y-2 text-sm text-slate-200">
                    {t.decisions?.map((d: any, dIdx: number) => {
                      if (typeof d === "string") {
                        return <li key={dIdx} className="leading-relaxed">• {d}</li>;
                      }
                      return (
                        <li key={dIdx} className="p-2.5 rounded-lg bg-slate-900 border border-slate-800/80 space-y-1">
                          <p className="leading-relaxed">{d.decision}</p>
                          {(d.responsible || d.deadline) && (
                            <div className="flex flex-wrap items-center gap-3 text-xs text-indigo-300 pt-1 font-mono">
                              {d.responsible && <span>Ответственный: <strong>{d.responsible}</strong></span>}
                              {d.deadline && <span>Срок: <strong>{d.deadline}</strong></span>}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-8 text-slate-400 text-sm">
              Решения формируются локальной моделью...
            </div>
          )}
        </div>
      </div>

      {/* Floating AI selection popover */}
      {selectionRange && (
        <div
          style={{ position: "absolute", left: `${selectionRange.x}px`, top: `${selectionRange.y}px` }}
          className="z-50 w-80 rounded-2xl bg-slate-900 border border-indigo-500/50 shadow-2xl p-3.5 space-y-3 animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-400">
              <SteppeIcon className="w-3.5 h-3.5" />
              <span>AI Редактор выделения</span>
            </div>
            <button onClick={closeToolbar} className="text-slate-400 hover:text-white p-0.5">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="text-xs text-slate-300 bg-slate-950 p-2 rounded-lg border border-slate-800 line-clamp-2 italic">
            "{selectedText}"
          </div>

          {!editResult ? (
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Инструкция: например: сделай более официально"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleApplyAiEdit()}
                className="w-full py-1.5 px-2.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={handleApplyAiEdit}
                disabled={isEditing || !instruction.trim()}
                className="w-full py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {isEditing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                <span>{isEditing ? "Переписываю..." : "Применить AI правку"}</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-emerald-300 bg-emerald-950/40 p-2.5 rounded-lg border border-emerald-800/60 leading-relaxed font-sans">
                {editResult}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(editResult);
                  }}
                  className="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-white"
                >
                  Скопировать
                </button>
                <button
                  type="button"
                  onClick={handleApplyEditToDocument}
                  className="py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs text-white font-medium"
                >
                  Применить
                </button>
                <button
                  type="button"
                  onClick={closeToolbar}
                  className="py-1.5 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300"
                >
                  Закрыть
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
