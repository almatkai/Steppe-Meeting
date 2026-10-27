import React, { useRef, useState } from "react";
import {
  CloudArrowUp as UploadCloud,
  FileAudio,
  FileVideo,
  X,
  CheckCircle as CheckCircle2,
} from "@phosphor-icons/react";

interface AudioDropZoneProps {
  file: File | null;
  onFileSelect: (file: File | null) => void;
}

export const AudioDropZone: React.FC<AudioDropZoneProps> = ({ file, onFileSelect }) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelect(e.dataTransfer.files[0]);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="w-full">
      <input
        type="file"
        ref={inputRef}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFileSelect(e.target.files[0]);
          }
        }}
        accept="audio/*,video/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac,.mp4,.mov,.mkv,.webm"
        className="hidden"
      />

      {!file ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 ${
            isDragging
              ? "border-neutral-500 bg-neutral-800/70 scale-[1.01]"
              : "border-neutral-700/80 bg-neutral-900/40 hover:border-neutral-600 hover:bg-neutral-900/70"
          }`}
        >
          <div className="w-14 h-14 rounded-2xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-4 text-neutral-300">
            <UploadCloud className="w-7 h-7" />
          </div>
          <h3 className="text-base font-semibold text-white mb-1">
            Перетащите аудио- или видеофайл сюда
          </h3>
          <p className="text-sm text-neutral-400 mb-4 max-w-sm">
            Поддерживаются форматы MP3, WAV, M4A, MP4, WebM, OGG и др.
          </p>
          <button
            type="button"
            className="py-2 px-4 rounded-lg bg-neutral-800 border border-neutral-700 text-xs font-medium text-neutral-200 hover:bg-neutral-700 transition-colors"
          >
            Выбрать файл на диске
          </button>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-neutral-900/90 border border-neutral-700 flex items-center justify-between">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-300 shrink-0">
              {file.type.startsWith("video/") ? (
                <FileVideo className="w-6 h-6" />
              ) : (
                <FileAudio className="w-6 h-6" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium text-sm text-white truncate max-w-md">
                  {file.name}
                </p>
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                {formatFileSize(file.size)} • {file.type || "audio/video"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFileSelect(null);
            }}
            className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-rose-400 transition-colors"
            title="Удалить файл"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
};
