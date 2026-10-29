import type { ReleaseUpdate } from '../types';
import type { BusyReason, UpdateError, UpdateJob, UpdatePort, UpdateTarget, UpdateReceipt, UpdateObservation } from '../utils/updateController';

type Raw = Record<string, unknown>;
export interface UpdateDependencies {
  enabled(): boolean; supported(): boolean; captureBusy(): boolean; version(): Promise<string>;
  request(route: 'job' | 'download' | 'cancel', body?: {selection_id: string} | {job_id: string}): Promise<Raw>;
  check(input: {current_version: string; channel: 'stable' | 'beta'; platform: string; arch: string; force: boolean}): Promise<ReleaseUpdate>;
  install(id: string): Promise<Raw>; id(): string;
  storage?: { getItem(key: string): string | null | undefined; setItem(key: string, value: string): void };
}
const codes: Record<string, UpdateError> = {
  checksum:'checksum', checksum_mismatch:'checksum', disk_full:'disk_full', not_writable:'not_writable', network:'network',
  download_failed:'download_failed', prepare_failed:'install_failed', install_failed:'install_failed', journal_invalid:'journal_invalid',
  recovery_failed:'recovery_required', recovery_required:'recovery_required', busy:'busy', conflict:'busy', unsupported:'unsupported', interrupted:'interrupted', rolled_back:'install_failed', invalid_update_request:'stale_selection',
};
// Presentation only: obsolete failure receipts must not survive a manual update.
function versionAtLeast(current: string, target: string): boolean {
  const parse = (s: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  const a = parse(current), b = parse(target);
  if (!a || !b) return current === target;
  for (let i = 1; i <= 3; i++) if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]);
  if (!a[4] || !b[4]) return !a[4] || !!b[4];
  const left = a[4].split('.'), right = b[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === undefined) return false;
    if (right[i] === undefined) return true;
    const an = /^\d+$/.test(left[i]), bn = /^\d+$/.test(right[i]);
    if (an && bn) return BigInt(left[i]) > BigInt(right[i]);
    if (an !== bn) return !an;
    return left[i] > right[i];
  }
  return true;
}
export function createUpdatePort(deps: UpdateDependencies): UpdatePort {
  const targets = new Map<string, UpdateTarget>(), seen = new Set<string>();
  const dismissed = new Set<string>();
  let lastJob: UpdateJob | null = null;
  const busyReasons = (raw: unknown): BusyReason[] => [...new Set<BusyReason>([
    ...(deps.captureBusy() ? ['recording' as const] : []),
    ...(Array.isArray(raw) ? raw.map(v => v === 'recording' ? 'recording' as const : v === 'generation' ? 'generation' as const : 'processing' as const) : []),
  ])];
  function jobFrom(raw: Raw): UpdateJob | null {
    const stage = String(raw.stage);
    if (!raw.job_id || ['idle','completed','rolled_back','recovery_required'].includes(stage)) return null;
    const id = String(raw.job_id);
    if (stage === 'error') {
      let hidden = dismissed.has(id);
      try { hidden ||= deps.storage?.getItem(`steppe-update-dismissed:${id}`) === '1'; } catch { /* memory fallback */ }
      if (hidden) return null;
    }
    const target = targets.get(id) || {status:'available' as const, repository:'almatkai/Steppe-Meeting', current_version:'', checked_at:'', channel:raw.channel === 'beta' ? 'beta' as const : 'stable' as const, latest_version:String(raw.version || '')};
    const mapped = stage === 'downloading' ? 'downloading' : stage === 'verifying' ? 'verifying' : ['ready','deferred'].includes(stage) ? 'ready' : stage === 'cancelled' ? 'cancelled' : ['preparing','awaiting_exit','replacing','backup_created','restarting'].includes(stage) ? 'installing' : 'failed';
    return {id,target,stage:mapped, bytes:Number(raw.bytes)||0,total:Number(raw.total_bytes)||undefined,busy:busyReasons(raw.busy),
      cancellable:raw.cancellable === true, autoEligible:raw.autoEligible === true,
      error:mapped === 'failed' ? codes[String(raw.error_code)] || 'unavailable' : stage === 'deferred' ? 'busy' : undefined};
  }
  return {
    async observe() {
      if (!deps.enabled()) return {supported:false,unavailable:'unsupported',busy:[],job:null};
      const raw = await deps.request('job');
      if (raw.stage === 'error' && raw.version && versionAtLeast(await deps.version(), String(raw.version))) {
        dismissed.add(String(raw.job_id));
      }
      lastJob = jobFrom(raw);
      const outcome: UpdateReceipt['outcome'] | null = raw.stage === 'completed' ? 'healthy' : raw.stage === 'rolled_back' ? 'rolled_back' : raw.stage === 'recovery_required' ? 'recovery_required' : null;
      const result: UpdateObservation = {supported:deps.supported(),busy:busyReasons(raw.busy),job:lastJob, ...(outcome && raw.job_id ? {terminal: {id: String(raw.job_id), outcome}} : {})};
      if (!outcome || !raw.job_id) return result;
      // Recovery is actionable until resolved, never a one-time notification.
      if (outcome === 'recovery_required') return {...result,receipt:{id:String(raw.job_id),version:String(raw.version),outcome}};
      // Old healthy journals must never announce success for a different running binary.
      if (outcome === 'healthy' && String(raw.version) !== await deps.version()) return result;
      const key = `steppe-update-receipt:${raw.job_id}:${raw.version}:${outcome}`;
      let acknowledged = seen.has(key);
      try { acknowledged ||= deps.storage?.getItem(key) === '1'; } catch { /* memory fallback */ }
      if (acknowledged) return result;
      seen.add(key);
      try { deps.storage?.setItem(key,'1'); } catch { /* storage denial cannot block terminal handling */ }
      return {...result,receipt:{id:String(raw.job_id),version:String(raw.version),outcome}};
    },
    async begin(target) {
      if (!deps.supported()) throw {code:'unsupported'};
      const existing = await deps.request('job'), active = jobFrom(existing);
      if (existing.stage === 'recovery_required') throw {code:'recovery_required'};
      if (active && ['downloading','verifying','ready','installing'].includes(active.stage)) { lastJob = active; return {job:active,owner:null}; }
      const selection = await deps.check({current_version:await deps.version(),channel:target.channel,platform:'darwin',arch:'aarch64',force:true});
      if (selection.installable === false) throw {code:'verification_unavailable'};
      if (selection.latest_version !== target.latest_version || !selection.selection_id) throw {code:'stale_selection'};
      let raw: Raw;
      try { raw = await deps.request('download',{selection_id:selection.selection_id}); }
      catch (error) {
        if ((error as {status?:number})?.status === 409) {
          const joined = jobFrom(await deps.request('job'));
          if (joined && ['downloading','verifying','ready','installing'].includes(joined.stage)) { lastJob = joined; return {job:joined,owner:null}; }
        }
        throw error;
      }
      targets.set(String(raw.job_id),target);
      const job = jobFrom(raw); if (!job) throw {code:'unavailable'};
      lastJob = job; return {job,owner:existing.job_id === raw.job_id ? null : deps.id()};
    },
    async cancel(id) { await deps.request('cancel',{job_id:id}); targets.delete(id); },
    dismiss(id) {
      dismissed.add(id);
      try { deps.storage?.setItem(`steppe-update-dismissed:${id}`,'1'); } catch { /* memory fallback */ }
    },
    async recover(id) {
      if (!deps.supported()) throw {code:'unsupported'};
      if (deps.captureBusy()) throw {code:'busy'};
      const raw = await deps.install(id);
      const job = jobFrom(raw);
      if (raw.stage === 'deferred') throw {code:'busy'};
      if (!job) throw {code:'recovery_required'};
      return lastJob = job;
    },
    async install(id) {
      if (!deps.supported()) throw {code:'unsupported'};
      if (!lastJob || lastJob.id !== id) lastJob = jobFrom(await deps.request('job'));
      if (deps.captureBusy()) {
        if (!lastJob) throw {code:'busy'};
        return {...lastJob,stage:'ready',busy:['recording'],autoEligible:false,error:'busy'};
      }
      let raw: Raw;
      try { raw = await deps.install(id); }
      catch (error) {
        // Native acknowledgements/conflicts are not installation receipts or failures.
        const code = codes[String((error as {code?:string})?.code)];
        try {
          const observed = jobFrom(await deps.request('job'));
          if (observed?.stage === 'installing' || observed?.stage === 'failed') return lastJob = observed;
          if (observed && (observed.busy.length || code === 'busy')) return lastJob = {...observed,autoEligible:false,error:'busy'};
        } catch { /* preserve neutral uncertainty */ }
        throw {code:code === 'unsupported' ? 'unsupported' : 'unavailable'};
      }
      if (raw.stage === 'deferred' && lastJob) return lastJob = {...lastJob,stage:'ready',busy:busyReasons(raw.busy),autoEligible:false,error:'busy'};
      const job = jobFrom(raw); if (!job) throw {code:'unavailable'};
      return lastJob = job;
    },
  };
}
