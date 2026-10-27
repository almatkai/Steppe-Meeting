import type { SaveState } from '../../utils/settingsAutosave';

export function SaveIndicator({ state, onRetry, label }: { state: SaveState; onRetry: () => void; label: string }) {
  const text = state.error ? `Не удалось сохранить: ${state.error}` : state.validation ? `Черновик: ${state.validation}` : state.status === 'saving' || state.status === 'pending' ? 'Сохраняем…' : state.status === 'saved' ? 'Сохранено' : '';
  return <div id={label === 'LLM' ? 'llm-save-status' : 'stt-save-status'} role="status" aria-live="polite" className="min-h-4 text-[11px] text-neutral-400 flex flex-wrap items-center gap-2">
    <span className="sr-only">{label}: </span><span>{text}</span>
    {state.error && <button type="button" onClick={onRetry} className="underline rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500">Повторить</button>}
  </div>;
}
