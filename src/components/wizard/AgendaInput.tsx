import React from "react";
import {
  ListNumbers as ListOrdered,
} from "@phosphor-icons/react";

interface AgendaInputProps {
  agenda: string;
  onChange: (agenda: string) => void;
}

export const AgendaInput: React.FC<AgendaInputProps> = ({ agenda, onChange }) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
          <ListOrdered className="w-3.5 h-3.5 text-neutral-400" />
          <span>Повестка дня (Күн тәртібі)</span>
        </label>
        <span className="text-xs text-neutral-400">Опционально</span>
      </div>

      <textarea
        rows={4}
        placeholder={`1. Рассмотрение статуса разработки модуля AI\n2. Утверждение сроков поставки и ответственных лиц\n3. Разное`}
        value={agenda}
        onChange={(e) => onChange(e.target.value)}
        className="w-full p-3 text-sm rounded-xl bg-neutral-900 border border-neutral-700 text-white placeholder-neutral-400 focus:outline-none focus:border-neutral-500 transition-colors resize-none leading-relaxed font-sans"
      />
      <p className="text-xs text-neutral-400">
        Указание повестки помогает модели точнее соотнести решения с пунктами регламента.
      </p>
    </div>
  );
};
