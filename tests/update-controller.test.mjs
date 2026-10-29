import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateController } from '../src/utils/updateController.ts';
const target = { status: 'available', channel: 'beta', current_version: '1', latest_version: '2', release_url: 'https://github.com/almatkai/Steppe-Meeting/releases/tag/v2' };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let job = null, busy = [], receipt;
  const calls = { begin: 0, install: 0, cancel: 0 };
  const port = {
    observe: async () => ({ supported: true, busy, job, receipt }),
    begin: async () => { calls.begin++; job = { id: 'job', target, stage: 'downloading', bytes: 0, total: 100, busy, autoEligible: true }; return { job, owner: 'lease' }; },
    cancel: async () => { calls.cancel++; job = { ...job, stage: 'cancelled' }; },
    install: async () => { calls.install++; return job = { ...job, stage: 'installing' }; },
  };
  const controller = createUpdateController(port);
  return { port, calls, controller, ready: (patch = {}) => job = { ...job, stage: 'ready', ...patch }, busy: value => busy = value, receipt: value => receipt = value };
}
test('one click; rapid clicks coalesce; frozen target; acknowledgement never means success', async () => {
  const f = fixture(); await f.controller.refresh();
  await Promise.all([f.controller.begin(target), f.controller.begin({ ...target, latest_version: '3' })]);
  assert.equal(f.calls.begin, 1); assert.equal(f.controller.getSnapshot().target.latest_version, '2');
  assert.ok(Object.isFrozen(f.controller.getSnapshot().target));
  f.ready(); await f.controller.refresh(); assert.equal(f.calls.install, 1);
  assert.equal(f.controller.getSnapshot().stage, 'installing'); assert.equal(f.controller.getSnapshot().receipt, undefined);
});
test('busy at click or during download permanently requires explicit second click', async () => {
  for (const initialBusy of [true, false]) {
    const f = fixture(); if (initialBusy) f.busy(['recording']); await f.controller.refresh(); await f.controller.begin(target);
    if (!initialBusy) f.controller.activity(['generation']);
    f.busy([]); f.ready({ busy: [] }); await f.controller.refresh();
    assert.equal(f.calls.install, 0); await f.controller.install(); assert.equal(f.calls.install, 1);
  }
});
test('backend activity latch covers activity between frontend polls', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.begin(target);
  f.ready({ autoEligible: false }); await f.controller.refresh(); assert.equal(f.calls.install, 0);
});
test('final 409 returns to ready and never retries automatically', async () => {
  const f = fixture(); f.port.install = async () => { f.calls.install++; throw { status: 409 }; };
  await f.controller.refresh(); await f.controller.begin(target); f.ready(); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().stage, 'ready'); assert.equal(f.controller.getSnapshot().error, 'busy');
  await f.controller.refresh(); assert.equal(f.calls.install, 1);
});
test('cancel during pending begin cancels its eventual job and discards target', async () => {
  const f = fixture(), pending = deferred(); f.port.begin = () => pending.promise;
  await f.controller.refresh(); const start = f.controller.begin(target); await tick(); const cancel = f.controller.cancel();
  pending.resolve({ job: { id: 'job', target, stage: 'ready', busy: [], autoEligible: true }, owner: 'lease' });
  await Promise.all([start, cancel]); assert.equal(f.calls.cancel, 1); assert.equal(f.calls.install, 0); assert.equal(f.controller.getSnapshot().target, null);
});
test('late poll cannot resurrect cancelled intent', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.begin(target);
  const pending = deferred(); f.port.observe = () => pending.promise;
  const poll = f.controller.refresh(); await f.controller.cancel();
  pending.resolve({ supported: true, busy: [], job: { id: 'job', target, stage: 'ready', busy: [], autoEligible: true } });
  await poll; assert.equal(f.controller.getSnapshot().stage, 'idle'); assert.equal(f.calls.install, 0);
});
test('restores across navigation/windows never claim auto-install ownership', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.begin(target); f.ready();
  const other = createUpdateController(f.port); await other.refresh(); assert.equal(other.getSnapshot().stage, 'ready'); assert.equal(f.calls.install, 0);
  const unmount = f.controller.subscribe(() => {}); unmount(); await f.controller.refresh(); assert.equal(f.calls.install, 1);
});
test('only healthy receipt produces success; rollback/recovery remain failures', async () => {
  for (const outcome of ['healthy', 'rolled_back', 'recovery_required']) {
    const f = fixture(); f.receipt({ id: 'receipt', version: '2', outcome }); await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().stage, outcome === 'healthy' ? 'completed' : 'failed');
    f.controller.reset(); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().stage, outcome === 'recovery_required' ? 'failed' : 'idle');
  }
});
test('unsupported gate does not begin; coded failure retries without exposing exceptions', async () => {
  const f = fixture(); f.port.observe = async () => ({ supported: false, job: null, busy: [] }); await f.controller.refresh(); await f.controller.begin(target); assert.equal(f.calls.begin, 0);
  f.port.observe = async () => ({ supported: true, job: null, busy: [] }); await f.controller.refresh();
  f.port.begin = async () => { throw { code: 'checksum', message: '/secret/private stack' }; }; await f.controller.begin(target);
  assert.equal(f.controller.getSnapshot().error, 'checksum');
  f.port.begin = async () => ({ owner: null, job: { id: 'existing', target, stage: 'ready', busy: [], autoEligible: true } }); await f.controller.begin(target);
  assert.equal(f.controller.getSnapshot().stage, 'ready'); assert.equal(f.calls.install, 0);
});
test('cancel rejection preserves download stage and persists its error through unchanged polls', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.begin(target);
  f.port.cancel = async () => { throw {code:'network'}; }; await f.controller.cancel();
  assert.equal(f.controller.getSnapshot().stage,'downloading'); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().error,'cancel_failed'); f.ready({autoEligible:false}); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().stage,'ready');
});
test('observation outage keeps capability unknown and retries', async () => {
  const f = fixture(); const observe = f.port.observe; f.port.observe = async () => { throw Error(); };
  await f.controller.refresh(); assert.equal(f.controller.getSnapshot().initialized,false);
  f.port.observe = observe; await f.controller.refresh(); assert.equal(f.controller.getSnapshot().supported,true);
});
test('terminal receipt always excludes job before and after reset', async () => {
  const f=fixture(); f.port.observe=async()=>({supported:true,busy:[],job:{id:'tx',stage:'installing',target,busy:[],autoEligible:false},receipt:{id:'tx',version:'2',outcome:'healthy'}});
  await f.controller.refresh(); f.controller.reset(); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().stage,'idle');
});
test('acknowledged terminal from another observer cannot strand an installing window',async()=>{
 const f=fixture();await f.controller.refresh();await f.controller.begin(target);f.ready();await f.controller.refresh();assert.equal(f.controller.getSnapshot().stage,'installing');
 f.port.observe=async()=>({supported:true,busy:[],job:null,terminal:{id:'job',outcome:'healthy'}});
 await f.controller.refresh();assert.equal(f.controller.getSnapshot().stage,'idle');assert.equal(f.controller.getSnapshot().job,null);
});

test('start failures without a job survive idle polls',async()=>{
 for(const code of ['stale_selection','verification_unavailable','network']){
  const f=fixture();await f.controller.refresh();f.port.begin=async()=>{throw{code};};
  await f.controller.begin(target);await f.controller.refresh();await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().stage,'failed');assert.equal(f.controller.getSnapshot().error,code);
 }
});
