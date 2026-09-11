import React, { useMemo, useState } from "react";
import { Search, Copy, Check, User, Clock, FileAudio, Pencil, X, Info } from "lucide-react";
import { api } from "../../services/api";
import type { TranscriptSegment } from "../../types";

interface TranscriptViewProps {
  meetingId: string;
  transcriptText: string;
  segments: TranscriptSegment[];
  audioFilename?: string;
  speakerSource?: string;
  onSpeakersChanged?: () => void | Promise<void>;
}

/**
 * Explains where speaker labels came from. Turn detection finds boundaries, not
 * identities, so the UI has to say so rather than let an official protocol go
 * out with names the system guessed.
 */
const SPEAKER_SOURCE_NOTE: Record<string, string> = {
  provider: "Говорящие размечены сервисом распознавания.",
  pause: "Смены говорящего определены по паузам. Имена назначьте вручную.",
  "pause+llm": "Смены говорящего определены по паузам, имена предложены моделью. Проверьте перед экспортом.",
  "provider+llm": "Говорящие размечены сервисом, имена предложены моделью. Проверьте перед экспортом.",
};

export const TranscriptView: React.FC<TranscriptViewProps> = ({
  meetingId,
  transcriptText,
  segments,
  audioFilename,
  speakerSource,
  onSpeakersChanged,
}) => {
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [renameError, setRenameError] = useState("");

  const handleCopy = () => {
    navigator.clipboard.writeText(transcriptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const speakers = useMemo(() => {
    const seen = new Set<string>();
    for (const segment of segments || []) {
      if (segment.speaker) seen.add(segment.speaker);
    }
    return Array.from(seen);
  }, [segments]);

  const startEditing = (speaker: string) => {
    setEditingSpeaker(speaker);
    setDraftName(speaker);
    setRenameError("");
  };

  const cancelEditing = () => {
    setEditingSpeaker(null);
    setDraftName("");
    setRenameError("");
  };

  const submitRename = async () => {
    if (!editingSpeaker) return;
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === editingSpeaker) {
      cancelEditing();
      return;
    }

    try {
      setIsSaving(true);
      setRenameError("");
      await api.renameSpeaker(meetingId, editingSpeaker, trimmed);
      // The backend rebuilds the flat transcript too, so refresh from it rather
      // than patching local state and drifting out of sync with the export.
      await onSpeakersChanged?.();
      cancelEditing();
    } catch (e: any) {
      setRenameError(e.message || String(e));
    } finally {
      setIsSaving(false);
    }
  };

  const filteredSegments = (segments || []).filter(
    (s) =>
      s.text.toLowerCase().includes(search.toLowerCase()) ||
      s.speaker.toLowerCase().includes(search.toLowerCase())
  );

  const sourceNote = speakerSource ? SPEAKER_SOURCE_NOTE[speakerSource] : undefined;

  return (
    <div className="space-y-4">
      {/* Top action bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            placeholder="Поиск по стенограмме..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full py-2 px-3 pl-9 text-xs rounded-xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
          />
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? "Скопировано" : "Копировать текст"}</span>
        </button>
      </div>

      {audioFilename && (
        <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800 flex items-center gap-2.5 text-xs text-slate-400">
          <FileAudio className="w-4 h-4 text-indigo-400 shrink-0" />
          <span>
            Аудиофайл: <strong className="text-white">{audioFilename}</strong>
          </span>
        </div>
      )}

      {/* Speaker roster with inline renaming */}
      {speakers.length > 0 && (
        <div className="p-3.5 rounded-xl bg-slate-900/50 border border-slate-800 space-y-2.5">
          <div className="flex items-start gap-2 text-[11px] text-slate-400">
            <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-px" />
            <span>
              {sourceNote || "Нажмите на имя, чтобы переименовать говорящего во всей стенограмме."}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {speakers.map((speaker) =>
              editingSpeaker === speaker ? (
                <div key={speaker} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={draftName}
                    autoFocus
                    disabled={isSaving}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") cancelEditing();
                    }}
                    className="py-1 px-2 w-40 rounded-lg bg-slate-950 border border-indigo-500 text-white text-[11px] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={submitRename}
                    disabled={isSaving}
                    className="p-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
                    title="Сохранить"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditing}
                    disabled={isSaving}
                    className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50"
                    title="Отмена"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  key={speaker}
                  type="button"
                  onClick={() => startEditing(speaker)}
                  className="group flex items-center gap-1.5 py-1 px-2.5 rounded-lg bg-slate-950/70 border border-slate-800 text-[11px] font-medium text-slate-300 hover:text-white hover:border-indigo-500/60 transition-colors"
                >
                  <User className="w-3 h-3 text-indigo-400" />
                  <span>{speaker}</span>
                  <Pencil className="w-2.5 h-2.5 text-slate-500 group-hover:text-indigo-300" />
                </button>
              )
            )}
          </div>

          {renameError && (
            <p className="text-[11px] text-rose-400">{renameError}</p>
          )}
        </div>
      )}

      {/* Segments Display */}
      {segments && segments.length > 0 ? (
        <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
          {filteredSegments.map((seg) => (
            <div
              key={seg.index}
              className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-colors space-y-1.5 group"
            >
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => startEditing(seg.speaker)}
                  className="flex items-center gap-1.5 text-indigo-400 font-semibold hover:text-indigo-300 transition-colors"
                  title="Переименовать говорящего"
                >
                  <User className="w-3 h-3" />
                  <span>{seg.speaker}</span>
                </button>
                <div className="flex items-center gap-1 text-slate-400 font-mono text-[11px]">
                  <Clock className="w-3 h-3" />
                  <span>{seg.timestamp_str || `[${seg.timestamp_start}s]`}</span>
                </div>
              </div>
              <p className="text-sm text-slate-200 leading-relaxed font-sans select-text">
                {seg.text}
              </p>
            </div>
          ))}

          {filteredSegments.length === 0 && (
            <p className="p-6 text-center text-xs text-slate-500">
              Ничего не найдено по запросу «{search}»
            </p>
          )}
        </div>
      ) : (
        <div className="p-6 rounded-2xl bg-slate-900/40 border border-slate-800 font-mono text-xs text-slate-300 leading-relaxed whitespace-pre-wrap select-text max-h-[600px] overflow-y-auto">
          {transcriptText || "Стенограмма пока отсутствует..."}
        </div>
      )}
    </div>
  );
};
