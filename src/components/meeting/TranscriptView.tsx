import React, { useState } from "react";
import { Search, Copy, Check, User, Clock, FileAudio } from "lucide-react";
import type { TranscriptSegment } from "../../types";

interface TranscriptViewProps {
  transcriptText: string;
  segments: TranscriptSegment[];
  audioFilename?: string;
}

export const TranscriptView: React.FC<TranscriptViewProps> = ({
  transcriptText,
  segments,
  audioFilename,
}) => {
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(transcriptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const filteredSegments = segments.filter((s) =>
    s.text.toLowerCase().includes(search.toLowerCase()) ||
    s.speaker.toLowerCase().includes(search.toLowerCase())
  );

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
          <span>Аудиофайл: <strong className="text-white">{audioFilename}</strong></span>
        </div>
      )}

      {/* Segments Display */}
      {segments && segments.length > 0 ? (
        <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
          {filteredSegments.map((seg, idx) => (
            <div
              key={idx}
              className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-colors space-y-1.5 group"
            >
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-indigo-400 font-semibold">
                  <User className="w-3 h-3" />
                  <span>{seg.speaker}</span>
                </div>
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
        </div>
      ) : (
        <div className="p-6 rounded-2xl bg-slate-900/40 border border-slate-800 font-mono text-xs text-slate-300 leading-relaxed whitespace-pre-wrap select-text max-h-[600px] overflow-y-auto">
          {transcriptText || "Стенограмма пока отсутствует..."}
        </div>
      )}
    </div>
  );
};
