import type { ReleaseUpdate } from '../types';

export type UpdateError = 'network' | 'checksum' | 'disk_full' | 'not_writable' | 'busy' | 'install_failed' | 'unsupported' | 'interrupted' | 'unavailable' | 'download_failed' | 'stale_selection' | 'verification_unavailable' | 'journal_invalid' | 'recovery_required' | 'cancel_failed';
export type BusyReason = 'recording' | 'processing' | 'generation';
export type UpdateStage = 'idle' | 'starting' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'cancelling' | 'failed' | 'completed';
export type UpdateTarget = Readonly<ReleaseUpdate>;
export interface UpdateJob {
  id: string; stage: 'downloading' | 'verifying' | 'ready' | 'installing' | 'failed' | 'cancelled';
  target: UpdateTarget; bytes: number; total?: number; busy: BusyReason[]; error?: UpdateError;
  /** Monotonic server-owned latch: false once ANY activity occurred during this job. */
  autoEligible: boolean; cancellable?: boolean;
}
export interface UpdateReceipt { id: string; version: string; outcome: 'healthy' | 'rolled_back' | 'recovery_required' }
export interface UpdateObservation {
  supported: boolean; unavailable?: 'unsupported' | 'not_writable'; busy: BusyReason[];
  job: UpdateJob | null; receipt?: UpdateReceipt; terminal?: {id: string; outcome: UpdateReceipt['outcome']};
}
/** Native/backend must atomically own a single job, the activity latch, install lock,
 * and owner lease across windows. HTTP acknowledgements are never healthy receipts. */
export interface UpdatePort {
  observe(): Promise<UpdateObservation>;
  begin(target: UpdateTarget): Promise<{ job: UpdateJob; owner: string | null }>;
  cancel(id: string): Promise<void>;
  install(id: string, owner: string | null): Promise<UpdateJob>;
  recover?(id: string): Promise<UpdateJob>;
  dismiss?(id: string): void;
}
export interface UpdateState {
  stage: UpdateStage; initialized: boolean; supported: boolean; unavailable?: UpdateError;
  target: UpdateTarget | null; job: UpdateJob | null; busy: BusyReason[];
  error?: UpdateError; receipt?: UpdateReceipt;
}
export const updateActive = (s: UpdateState) => ['starting', 'downloading', 'verifying', 'ready', 'installing', 'cancelling'].includes(s.stage);
export const updateDownloadUrl = (s: UpdateState, releaseUrl: string | null): string | null =>
  releaseUrl || (s.receipt?.outcome === 'recovery_required' ? 'https://github.com/almatkai/Steppe-Meeting/releases' : null);
export const busyText = (busy: BusyReason[]) => busy.includes('recording') ? 'Аудио ещё используется. Завершите запись, сохраните или удалите черновик перед установкой' : busy.includes('processing') ? 'Идёт обработка встречи. Установить можно после её завершения' : busy.includes('generation') ? 'Идёт генерация. Установить можно после её завершения' : '';
export function updateErrorCode(error: unknown): UpdateError {
  const code = (error as { code?: string })?.code;
  if (['network', 'checksum', 'disk_full', 'not_writable', 'busy', 'install_failed', 'unsupported', 'interrupted', 'unavailable', 'download_failed', 'stale_selection', 'verification_unavailable', 'journal_invalid', 'recovery_required', 'cancel_failed'].includes(code || '')) return code as UpdateError;
  const status = (error as { status?: number })?.status;
  return status === 409 ? 'busy' : 'unavailable';
}

export function createUpdateController(port: UpdatePort) {
  let state: UpdateState = { stage: 'idle', initialized: false, supported: false, target: null, job: null, busy: [] };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  let epoch = 0, intent = false, owner: string | null = null;
  let beginPromise: Promise<{ job: UpdateJob; owner: string | null }> | undefined;
  let polling: Promise<void> | undefined;
  let installing = false;
  const seenReceipts = new Set<string>();
  const cancelled = new Set<string>();
  const dismissed = new Set<string>();
  const accept = (job: UpdateJob) => {
    if (cancelled.has(job.id)) return;
    const same = state.job?.id === job.id && state.job?.stage === job.stage;
    if (job.busy.length || !job.autoEligible) intent = false;
    if (job.stage === 'cancelled') { intent = false; set({ stage: 'idle', job: null, target: null, error: undefined }); return; }
    set({ job, target: state.target || Object.freeze({ ...job.target }), busy: job.busy,
      stage: job.stage, error: job.error || (same ? state.error : undefined) });
  };
  const install = async () => {
    if (installing || state.stage !== 'ready' || state.busy.length || !state.job) return;
    installing = true;
    intent = false;
    const token = epoch, id = state.job.id;
    set({ stage: 'installing', error: undefined });
    try {
      const job = await port.install(id, owner);
      if (token === epoch) accept(job);
    } catch (error) {
      if (token === epoch) {
        const code = updateErrorCode(error);
        set({ stage: code === 'busy' ? 'ready' : 'failed', error: code });
      }
    } finally { installing = false; }
  };
  const refresh = () => {
    if (polling) return polling;
    const token = epoch;
    polling = (async () => {
      try {
        const value = await port.observe();
        if (token !== epoch || beginPromise || installing || state.stage === 'cancelling') return;
        set({ initialized: true, supported: value.supported, unavailable: value.unavailable, busy: value.busy });
        if (value.busy.length) intent = false;
        if (value.terminal && state.job && value.terminal.id === state.job.id && !value.receipt) {
          intent = false;
          set({job:null, target:null, stage:'idle',error:undefined});
        }
        if (!value.job && !value.receipt && !value.terminal && state.job) {
          intent = false; set({job:null,target:null,stage:'idle',error:undefined});
        }
        if (value.job && !dismissed.has(value.job.id) && !value.receipt && !value.terminal) accept({ ...value.job, busy: [...new Set([...value.job.busy, ...value.busy])] });
        // Only the owner of this click can advance. Restores/other windows never auto-install.
        if (intent && owner && state.stage === 'ready' && !state.busy.length) await install();
        if (value.receipt && (value.receipt.outcome === 'recovery_required' || !seenReceipts.has(value.receipt.id))) {
          seenReceipts.add(value.receipt.id);
          intent = false;
          set({ receipt: value.receipt, job: null, stage: value.receipt.outcome === 'healthy' ? 'completed' : 'failed',
            error: value.receipt.outcome === 'healthy' ? undefined : value.receipt.outcome === 'recovery_required' ? 'recovery_required' : 'install_failed' });
        }
      } catch {
        if (token === epoch) set({ ...(updateActive(state) ? {} : { error: 'network' as const }) });
      }
    })().finally(() => { polling = undefined; });
    return polling;
  };
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh,
    async begin(target: UpdateTarget) {
      if (!state.initialized || !state.supported || updateActive(state) || state.receipt?.outcome === 'recovery_required') return;
      if (state.job?.stage === 'failed') { dismissed.add(state.job.id); port.dismiss?.(state.job.id); }
      const token = ++epoch;
      intent = state.busy.length === 0;
      owner = null;
      set({ stage: 'starting', target: Object.freeze({ ...target }), error: undefined, receipt: undefined, job: null });
      const request = Promise.resolve().then(() => port.begin(state.target!));
      beginPromise = request;
      try {
        const result = await request;
        if (token !== epoch) return;
        owner = result.owner;
        if (!owner) { intent = false; set({ target: Object.freeze({ ...result.job.target }) }); }
        accept(result.job);
        if (intent && state.stage === 'ready') await install();
      } catch (error) { if (token === epoch) { intent = false; set({ stage: 'failed', error: updateErrorCode(error) }); } }
      finally { if (beginPromise === request) beginPromise = undefined; }
    },
    install,
    async recover() {
      if (installing || state.busy.length || state.receipt?.outcome !== 'recovery_required' || !port.recover) return;
      const id = state.receipt.id, token = epoch;
      installing = true; intent = false; set({stage:'installing',error:undefined});
      try { const job = await port.recover(id); if (token === epoch) accept(job); }
      catch (error) { if (token === epoch) set({stage:'failed',error:updateErrorCode(error)}); }
      finally { installing = false; }
    },
    reset() {
      if (updateActive(state) || state.receipt?.outcome === 'recovery_required') return;
      if (state.job?.stage === 'failed') { dismissed.add(state.job.id); port.dismiss?.(state.job.id); }
      set({ stage: 'idle', target: null, job: null, receipt: undefined, error: undefined });
    },
    async cancel() {
      if (!updateActive(state) || state.stage === 'installing' || state.stage === 'cancelling') return;
      ++epoch; intent = false; owner = null;
      const pending = beginPromise;
      const previous = state.stage;
      set({ stage: 'cancelling', error: undefined });
      try {
        const job = state.job || (pending ? (await pending).job : null);
        if (job) { set({ job }); await port.cancel(job.id); cancelled.add(job.id); }
        set({ stage: 'idle', job: null, target: null, error: undefined });
      } catch { set({ stage: state.job ? (state.job.stage === 'cancelled' ? previous : state.job.stage) : 'failed', error: 'cancel_failed' }); }
    },
    activity(busy: BusyReason[]) {
      if (busy.length) intent = false;
      set({ busy });
    },
  };
}
export type UpdateController = ReturnType<typeof createUpdateController>;
