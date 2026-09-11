import React, { useEffect, useRef, useState } from "react";
import {
  FileText,
  UploadCloud,
  Download,
  Trash2,
  FlaskConical,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ShieldCheck,
  FileUp,
} from "lucide-react";
import { api } from "../../services/api";
import type { ProtocolTemplate, ProtocolTemplateSlot, TemplateTestResult } from "../../types";

interface PreviewState {
  slots: ProtocolTemplateSlot[];
  render_ready: boolean;
  warnings: string[];
}

const DETAIL_LEVELS = [
  { value: "concise", label: "Краткий" },
  { value: "standard", label: "Стандартный" },
  { value: "detailed", label: "Подробный" },
] as const;

export const TemplateManager: React.FC = () => {
  const [templates, setTemplates] = useState<ProtocolTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Upload form
  const [showUpload, setShowUpload] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [additionalPrompt, setAdditionalPrompt] = useState("");
  const [detailLevel, setDetailLevel] = useState<"concise" | "standard" | "detailed">("standard");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Per-template state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TemplateTestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const loadTemplates = async () => {
    try {
      setLoading(true);
      setError("");
      const list = await api.listTemplates();
      setTemplates(list);
    } catch (e: any) {
      setError(e.message || "Не удалось загрузить шаблоны");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  const handleFileSelect = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setUploadError("");
    if (f && !name.trim()) {
      setName(f.name.replace(/\.docx$/i, ""));
    }
  };

  const handleCheck = async () => {
    if (!file) return;
    try {
      setChecking(true);
      setUploadError("");
      const res = await api.previewTemplateSlots(file);
      setPreview({ slots: res.slots, render_ready: res.render_ready, warnings: res.warnings || [] });
    } catch (e: any) {
      setPreview(null);
      setUploadError(e.message || "Ошибка проверки шаблона");
    } finally {
      setChecking(false);
    }
  };

  const handleUpload = async () => {
    if (!file || !name.trim()) {
      setUploadError("Выберите .docx файл и укажите название шаблона");
      return;
    }
    try {
      setUploading(true);
      setUploadError("");
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim());
      form.append("description", description.trim());
      form.append("additional_prompt", additionalPrompt.trim());
      form.append("detail_level", detailLevel);
      await api.uploadTemplate(form);
      // reset form
      setFile(null);
      setName("");
      setDescription("");
      setAdditionalPrompt("");
      setDetailLevel("standard");
      setPreview(null);
      setShowUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadTemplates();
    } catch (e: any) {
      setUploadError(e.message || "Ошибка загрузки шаблона");
    } finally {
      setUploading(false);
    }
  };

  const handleTest = async (id: string) => {
    try {
      setTesting((p) => ({ ...p, [id]: true }));
      setTestErrors((p) => ({ ...p, [id]: "" }));
      const res = await api.testTemplate(id, {});
      setTestResults((p) => ({ ...p, [id]: res }));
      await loadTemplates(); // refresh has_test_docx flag
    } catch (e: any) {
      setTestErrors((p) => ({ ...p, [id]: e.message || "Ошибка тестирования" }));
    } finally {
      setTesting((p) => ({ ...p, [id]: false }));
    }
  };

  const handleDelete = async (t: ProtocolTemplate) => {
    if (t.id === "default-protocol-template") return;
    if (!window.confirm(`Удалить шаблон «${t.name}»? Это действие нельзя отменить.`)) return;
    try {
      setDeletingId(t.id);
      setNotice("");
      const res = await api.deleteTemplate(t.id);
      if (res.detached_meetings) {
        setNotice(`Шаблон «${t.name}» удалён. ${res.detached_meetings} сов. переключено на стандартный протокол.`);
      }
      await loadTemplates();
    } catch (e: any) {
      setNotice("Не удалось удалить шаблон: " + (e.message || e));
    } finally {
      setDeletingId(null);
    }
  };

  const toggleExpanded = (id: string) =>
    setExpanded((p) => ({ ...p, [id]: !p[id] }));

  return (
    <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-violet-600/15 border border-violet-500/20 flex items-center justify-center text-violet-400">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Шаблоны протоколов</h3>
            <p className="text-[11px] text-slate-400">
              Кастомные .docx шаблоны для экспорта официальных протоколов
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.open(api.getSampleTemplateDownloadUrl(), "_blank")}
            className="flex items-center gap-1.5 py-1.5 px-3 rounded-lg bg-slate-950/70 border border-slate-800 text-slate-300 hover:text-white hover:border-slate-600 text-[11px] font-medium transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Образец .docx</span>
          </button>
          <button
            type="button"
            onClick={() => setShowUpload((v) => !v)}
            className="flex items-center gap-1.5 py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold transition-all shadow-sm shadow-indigo-600/30"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>{showUpload ? "Скрыть загрузку" : "Загрузить шаблон"}</span>
          </button>
        </div>
      </div>

      {/* Upload panel */}
      {showUpload && (
        <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Файл шаблона (.docx)</label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center gap-3 p-3 rounded-xl bg-slate-900 border border-dashed border-slate-700 hover:border-indigo-500 cursor-pointer transition-colors text-left"
              >
                <UploadCloud className="w-5 h-5 text-indigo-400 shrink-0" />
                <span className="min-w-0 block">
                  <span className="text-xs font-medium text-white truncate block">
                    {file ? file.name : "Нажмите, чтобы выбрать файл"}
                  </span>
                  <span className="text-[11px] text-slate-400 block">
                    Поля: {"{{ field }}"}, линии ___, инструкции [в скобках]
                  </span>
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
              />
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Название шаблона</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Например: Протокол совещания акимата"
                  className="w-full py-2 px-3 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs focus:outline-none focus:border-indigo-500 placeholder-slate-600"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Детализация</label>
                <select
                  value={detailLevel}
                  onChange={(e) => setDetailLevel(e.target.value as typeof detailLevel)}
                  className="w-full py-2 px-3 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs focus:outline-none focus:border-indigo-500"
                >
                  {DETAIL_LEVELS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Описание <span className="text-slate-500 font-normal">(необязательно)</span>
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Для каких совещаний подходит"
                className="w-full py-2 px-3 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs focus:outline-none focus:border-indigo-500 placeholder-slate-600"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Доп. инструкция для LLM <span className="text-slate-500 font-normal">(необязательно)</span>
              </label>
              <input
                type="text"
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                placeholder="Например: решения формулируй официально"
                className="w-full py-2 px-3 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs focus:outline-none focus:border-indigo-500 placeholder-slate-600"
              />
            </div>
          </div>

          {/* Preview result */}
          {preview && (
            <div className={`p-3 rounded-xl border space-y-2 ${preview.render_ready ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"}`}>
              <div className={`flex items-center gap-2 text-xs font-semibold ${preview.render_ready ? "text-emerald-300" : "text-amber-300"}`}>
                {preview.render_ready ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                <span>
                  Найдено полей: {preview.slots.length}
                  {preview.render_ready ? " • готов к рендеру" : " • требует доработки"}
                </span>
              </div>
              {preview.slots.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {preview.slots.slice(0, 20).map((s) => (
                    <span
                      key={s.key}
                      title={`${s.label} (${s.value_type})`}
                      className="px-2 py-0.5 rounded-md bg-slate-900 border border-slate-700 text-[11px] font-mono text-indigo-300"
                    >
                      {s.key}
                    </span>
                  ))}
                  {preview.slots.length > 20 && (
                    <span className="text-[11px] text-slate-400">+{preview.slots.length - 20} ещё</span>
                  )}
                </div>
              )}
              {preview.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  <span>{w}</span>
                </p>
              ))}
            </div>
          )}

          {uploadError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{uploadError}</span>
            </div>
          )}

          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={handleCheck}
              disabled={!file || checking || uploading}
              className="flex items-center gap-1.5 py-2 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700 disabled:opacity-50"
            >
              {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              <span>{checking ? "Проверка..." : "Проверить поля"}</span>
            </button>
            <button
              type="button"
              onClick={handleUpload}
              disabled={!file || !name.trim() || uploading || checking}
              className="flex items-center gap-1.5 py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-md shadow-indigo-600/25 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
              <span>{uploading ? "Загрузка..." : "Загрузить шаблон"}</span>
            </button>
          </div>
        </div>
      )}

      {/* Notice (detach info / delete errors) */}
      {notice && (
        <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-200 text-xs flex items-center gap-2">
          <FileText className="w-4 h-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="underline font-semibold shrink-0">
            Закрыть
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-xs">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Загрузка шаблонов...</span>
        </div>
      ) : error ? (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
          <button type="button" onClick={loadTemplates} className="underline font-semibold ml-auto shrink-0">
            Повторить
          </button>
        </div>
      ) : templates.length === 0 ? (
        <div className="p-6 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
          Шаблонов пока нет. Загрузите первый .docx через кнопку выше.
        </div>
      ) : (
        <div className="space-y-2.5">
          {templates.map((t) => {
            const isDefault = t.id === "default-protocol-template";
            const isOpen = !!expanded[t.id];
            const result = testResults[t.id];
            const testErr = testErrors[t.id];
            return (
              <div
                key={t.id}
                className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 hover:border-slate-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-white truncate">{t.name}</p>
                      {isDefault && (
                        <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-[10px] font-semibold">
                          Системный
                        </span>
                      )}
                      {t.render_ready ? (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-semibold">
                          Готов к рендеру
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px] font-semibold">
                          Черновик
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-[11px] text-slate-400 mt-1 truncate">{t.description}</p>
                    )}
                    <p className="text-[11px] text-slate-500 mt-1 font-mono">
                      {t.slots_count} полей • {t.detail_level || "standard"}
                      {t.created_at && ` • ${new Date(t.created_at).toLocaleDateString("ru-RU")}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(t.id)}
                      title={isOpen ? "Скрыть поля" : "Показать поля"}
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => window.open(api.getTemplateDownloadUrl(t.id, "working"), "_blank")}
                      title="Скачать DOCX"
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTest(t.id)}
                      disabled={!!testing[t.id]}
                      title="Протестировать шаблон (LLM)"
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                    >
                      {testing[t.id] ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <FlaskConical className="w-4 h-4" />
                      )}
                    </button>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => handleDelete(t)}
                        disabled={deletingId === t.id}
                        title="Удалить шаблон"
                        className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition-colors disabled:opacity-50"
                      >
                        {deletingId === t.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Slots */}
                {isOpen && (
                  <div className="mt-3 pt-3 border-t border-slate-800/80">
                    {t.slots && t.slots.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {t.slots.map((s) => (
                          <span
                            key={s.key}
                            title={`${s.label || s.key} (${s.value_type || "string"})`}
                            className="px-2 py-0.5 rounded-md bg-slate-900 border border-slate-700 text-[11px] font-mono text-indigo-300"
                          >
                            {s.key}
                            <span className="text-slate-500 ml-1">{s.value_type}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">Поля не найдены</p>
                    )}
                  </div>
                )}

                {/* Test result / error */}
                {(result || testErr) && (
                  <div className="mt-3 pt-3 border-t border-slate-800/80">
                    {testErr ? (
                      <p className="text-[11px] text-rose-300 flex items-center gap-1.5">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        <span>{testErr}</span>
                      </p>
                    ) : result ? (
                      <div className="flex items-center gap-3 flex-wrap text-[11px]">
                        <span className="flex items-center gap-1.5 text-emerald-300 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Тест пройден • заполнено полей: {result.slots_filled}</span>
                        </span>
                        {result.has_test_docx && (
                          <button
                            type="button"
                            onClick={() => window.open(api.getTestDocxDownloadUrl(t.id), "_blank")}
                            className="flex items-center gap-1 text-indigo-300 hover:text-indigo-200 underline font-medium"
                          >
                            <Download className="w-3 h-3" />
                            <span>Скачать тестовый DOCX</span>
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
