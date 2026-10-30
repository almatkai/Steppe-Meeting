import type { GenerationAttempt, GenerationModelsResult, GenerationOptions, GenerationProviderOption, GenerationRoute } from '../types';

export const generationProviderKey = (route: Pick<GenerationRoute, 'mode' | 'provider'>) => `${route.mode}:${route.provider}`;
export const canChooseGenerationRoute = (status: string, transcript: string, stopping = false) =>
  !stopping && ['transcribed', 'error', 'cancelled'].includes(status) && !!transcript.trim();
export const generationModelLabel = (route: GenerationRoute) => route.model || (route.mode === 'cli' ? 'модель по умолчанию CLI' : 'модель не указана');
export type GenerationDraft = { model: string; manual: boolean; list?: GenerationModelsResult; loading: boolean; listError: string };
export type GenerationRetryState = {
  open: boolean; loading: boolean; options: GenerationOptions | null; selected: string;
  drafts: Record<string, GenerationDraft>; error: string; startError: string; starting: boolean;
};
type Dependencies = {
  options(): Promise<GenerationOptions>;
  models(route: GenerationProviderOption): Promise<GenerationModelsResult>;
  start(route: GenerationRoute): Promise<void>;
};
const empty = (): GenerationRetryState => ({ open: false, loading: false, options: null, selected: '', drafts: {}, error: '', startError: '', starting: false });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One mounted meeting owns this draft; polling never writes into it. */
export function createGenerationRetry(deps: Dependencies, previousAttempt?: GenerationAttempt | null) {
  let state = empty(), session = 0, selection = 0, request = 0;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<GenerationRetryState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const selected = () => state.options?.providers.find(option => generationProviderKey(option) === state.selected);
  const current = (s: number) => state.open && session === s;
  const patchDraft = (key: string, patch: Partial<GenerationDraft>) => set({ drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...patch } } });
  const close = () => { ++session; ++selection; ++request; set(empty()); };
  const loadOptions = async () => {
    const s = ++session;
    set({ ...empty(), open: true, loading: true });
    try {
      const options = await deps.options();
      if (!current(s)) return;
      const last = options.last_attempt || previousAttempt;
      const initial = options.providers.find(option => last && generationProviderKey(option) === generationProviderKey(last))
        || options.providers.find(option => generationProviderKey(option) === generationProviderKey(options.default)) || options.providers[0];
      if (!initial) throw new Error('Нет доступных вариантов генерации');
      const drafts = Object.fromEntries(options.providers.map(option => [generationProviderKey(option), {
        model: last && generationProviderKey(option) === generationProviderKey(last) ? last.model : option.model,
        manual: true, loading: false, listError: '',
      }]));
      set({ options: { ...options, last_attempt: last || null }, drafts, selected: generationProviderKey(initial), loading: false });
    } catch (error) { if (current(s)) set({ loading: false, error: message(error) }); }
  };
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getSnapshot: () => state,
    open: loadOptions,
    close,
    selected,
    select(key: string) {
      if (state.starting || !state.options?.providers.some(option => generationProviderKey(option) === key)) return;
      ++selection; ++request;
      // A response for a provider left behind cannot land after A→B→A.
      set({ selected: key, startError: '', drafts: Object.fromEntries(Object.entries(state.drafts).map(([k, draft]) => [k, { ...draft, loading: false }])) });
    },
    model(value: string) {
      if (!state.starting && selected()) set({ startError: '', drafts: {
        ...state.drafts, [state.selected]: { ...state.drafts[state.selected], model: value },
      } });
    },
    manual() { if (!state.starting && selected()) patchDraft(state.selected, { manual: !state.drafts[state.selected].manual }); },
    async loadModels() {
      const option = selected();
      if (!option?.supports_models || state.starting) return;
      const s = session, key = state.selected, selectedAt = selection, token = ++request;
      patchDraft(key, { loading: true, listError: '' });
      try {
        const list = await deps.models(option);
        if (!current(s) || key !== state.selected || selectedAt !== selection || token !== request) return;
        patchDraft(key, { list, manual: !list.models.length || !!list.error, loading: false, listError: list.error ? `Не удалось получить список: ${list.error}. Модель можно ввести вручную.` : (list.models.length ? '' : 'Список пуст. Модель можно ввести вручную.') });
      } catch (error) {
        if (current(s) && key === state.selected && selectedAt === selection && token === request) {
          patchDraft(key, { loading: false, manual: true, listError: `Не удалось получить список: ${message(error)}. Модель можно ввести вручную.` });
        }
      }
    },
    async start() {
      const option = selected(), draft = state.drafts[state.selected];
      if (!state.open || !option || !draft || state.starting || (option.requires_model && !draft.model.trim())) return;
      const s = session;
      set({ starting: true, startError: '' });
      try {
        await deps.start({ mode: option.mode, provider: option.provider, model: draft.model });
        if (current(s)) close();
      } catch (error) { if (current(s)) set({ starting: false, startError: message(error) }); }
    },
  };
}
