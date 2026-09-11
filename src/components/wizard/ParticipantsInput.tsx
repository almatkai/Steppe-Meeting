import React, { useState } from "react";
import { Plus, Trash2, Users, User } from "lucide-react";
import type { Participant } from "../../types";

interface ParticipantsInputProps {
  participants: Participant[];
  onChange: (participants: Participant[]) => void;
}

export const ParticipantsInput: React.FC<ParticipantsInputProps> = ({ participants, onChange }) => {
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");

  const handleAdd = () => {
    if (!name.trim()) return;
    onChange([...participants, { name: name.trim(), position: position.trim() }]);
    setName("");
    setPosition("");
  };

  const handleRemove = (index: number) => {
    onChange(participants.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-indigo-400" />
          <span>Участники совещания</span>
        </label>
        <span className="text-xs text-slate-400">
          {participants.length} {participants.length === 1 ? "участник" : "участников"}
        </span>
      </div>

      {/* Input Row */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            placeholder="ФИО (например: Смагулов А.К.)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            className="w-full py-2 px-3 pl-8 text-sm rounded-lg bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <User className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-3" />
        </div>
        <div className="flex-1">
          <input
            type="text"
            placeholder="Должность (например: Руководитель проекта)"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            className="w-full py-2 px-3 text-sm rounded-lg bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium flex items-center gap-1 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Добавить</span>
        </button>
      </div>

      {/* Participants List */}
      {participants.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {participants.map((p, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-sm group hover:border-slate-700 transition-colors"
            >
              <div className="flex items-center gap-2 truncate">
                <span className="font-medium text-white truncate">{p.name}</span>
                {p.position && (
                  <span className="text-xs text-slate-400 truncate">— {p.position}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleRemove(idx)}
                className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 opacity-80 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
