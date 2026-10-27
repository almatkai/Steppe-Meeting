import React, { useState } from "react";
import {
  CheckCircle as CheckCircle2,
  User,
  CalendarBlank as Calendar,
  FileText,
  CheckSquare,
  Copy,
  Check,
  Warning as AlertTriangle,
} from "@phosphor-icons/react";
import { MarkdownViewer } from "../ui/MarkdownViewer";
import type { SummaryData } from "../../types";

interface SummaryViewProps {
  summaryRu: SummaryData;
  summaryKz: SummaryData;
}

export const SummaryView: React.FC<SummaryViewProps> = ({ summaryRu, summaryKz }) => {
  const [lang, setLang] = useState<"ru" | "kz">("ru");
  const [copied, setCopied] = useState(false);

  const activeSummary = lang === "kz" ? summaryKz : summaryRu;

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(activeSummary, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const topics = activeSummary?.topics || [];
  const actionItems =
    (activeSummary?.action_items && activeSummary.action_items.length > 0)
      ? activeSummary.action_items
      : topics.flatMap((t) => t.assignments || []);
  const decisions = activeSummary?.decisions || [];
  const issuesAndRisks = activeSummary?.issues_and_risks || [];

  return (
    <div className="space-y-6">
      {/* Header controls */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center p-1 rounded-xl bg-neutral-900 border border-neutral-800">
          <button
            type="button"
            onClick={() => setLang("ru")}
            className={`py-1.5 px-4 rounded-lg text-xs font-semibold transition-all ${
              lang === "ru" ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-400 hover:text-white"
            }`}
          >
            Русское резюме
          </button>
          <button
            type="button"
            onClick={() => setLang("kz")}
            className={`py-1.5 px-4 rounded-lg text-xs font-semibold transition-all ${
              lang === "kz" ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-400 hover:text-white"
            }`}
          >
            Қазақша қорытынды
          </button>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 py-2 px-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? "Скопировано" : "Копировать"}</span>
        </button>
      </div>

      {/* Executive Summary Card */}
      <div className="p-6 rounded-2xl bg-neutral-900 border border-neutral-700 shadow-xl space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-300">
          <FileText className="w-4 h-4" />
          <span>{lang === "kz" ? "Негізгі түйін" : "Краткое содержание (Executive Summary)"}</span>
        </div>
        {activeSummary?.executive_summary ? (
          <MarkdownViewer content={activeSummary.executive_summary} />
        ) : (
          <p className="text-sm text-neutral-400 italic">Краткое резюме еще формируется...</p>
        )}
      </div>

      {/* Action Items Matrix */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-300">
          <CheckSquare className="w-4 h-4 text-emerald-400" />
          <span>{lang === "kz" ? "Тапсырмалар мен жауаптылар:" : "Матрица поручений и задач:"}</span>
        </div>

        {actionItems.length > 0 ? (
          <div className="rounded-xl border border-neutral-800 overflow-hidden bg-neutral-900/60">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-950/60 text-neutral-400 uppercase font-semibold">
                  <th className="py-3 px-4 w-12">#</th>
                  <th className="py-3 px-4">Поручение / Задача</th>
                  <th className="py-3 px-4 w-48">Ответственный</th>
                  <th className="py-3 px-4 w-36">Срок</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/60 text-neutral-200">
                {actionItems.map((item, idx) => (
                  <tr key={idx} className="hover:bg-neutral-800/40 transition-colors">
                    <td className="py-3 px-4 text-neutral-400 font-mono">{idx + 1}</td>
                    <td className="py-3 px-4 font-medium leading-relaxed">{item.task}</td>
                    <td className="py-3 px-4 text-neutral-300">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="truncate">{item.assignee || "Не назначен"}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-neutral-400 font-mono">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span>{item.deadline || "В рабочем порядке"}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6 rounded-xl bg-neutral-900/40 border border-neutral-800 text-center text-xs text-neutral-400">
            Поручения не выделены или обрабатываются моделью.
          </div>
        )}
      </div>

      {/* Discussion Topics Summary */}
      {topics.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-300">
            {lang === "kz" ? "Талқыланған мәселелер:" : "Обсужденные вопросы:"}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {topics.map((t, idx) => (
              <div key={idx} className="p-4 rounded-xl bg-neutral-900/50 border border-neutral-800 space-y-1.5">
                <h4 className="text-xs font-semibold text-white">{t.topic}</h4>
                <p className="text-xs text-neutral-400 leading-relaxed">{t.discussion}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Decisions */}
      {decisions.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{lang === "kz" ? "Негізгі шешімдер:" : "Ключевые решения:"}</span>
          </div>
          <div className="space-y-2">
            {decisions.map((d: any, idx: number) => {
              const text = typeof d === "string" ? d : d.decision;
              return (
                <div key={idx} className="p-3 rounded-xl bg-neutral-900/60 border border-neutral-800 text-xs text-neutral-200">
                  • {text}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Issues & Risks */}
      {issuesAndRisks.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>{lang === "kz" ? "Мәселелер мен тәуекелдер:" : "Проблемы и риски:"}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {issuesAndRisks.map((item: any, idx: number) => (
              <div key={idx} className="p-3.5 rounded-xl bg-neutral-900/60 border border-neutral-800 space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold uppercase tracking-wider text-amber-400">
                    {item.type || "Проблема"}
                  </span>
                </div>
                <p className="text-xs text-white">{item.issue}</p>
                {item.impact && <p className="text-[11px] text-neutral-400 italic">Влияние: {item.impact}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
