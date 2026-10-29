import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdatePort } from '../src/services/updateAdapter.ts';
const target = { channel: 'stable', latest_version: '2' };
function fixture() {
  let raw = { stage: 'idle' }, version = '1', fail, selection = { installable: true, selection_id: 's', latest_version: '2' };
  const saved = new Map(), calls = [];
  const deps = { supported: () => true, enabled: () => true, captureBusy: () => false, version: async () => version,
    request: async (route) => { calls.push(route); if (route === 'download') return raw = { job_id: 'new'+version, stage: 'downloading', version: selection.latest_version }; return raw; },
    check: async () => selection, install: async () => { throw fail; }, id: () => 'owner',
    storage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v) } };
  return { port: createUpdatePort(deps), deps, calls, raw: v => raw = v, version: v => version = v, selection: v => selection = v, fail: v => fail = v };
}
test('raw terminal handoff never becomes installing; two consecutive updates and persisted receipt', async () => {
  const f = fixture();
  for (const v of ['2','3']) {
    f.version(v); f.raw({ job_id: 'tx'+v, stage: 'completed', version: v });
    const value = await f.port.observe(); assert.equal(value.job, null); assert.equal(value.receipt.version, v);
    assert.equal((await createUpdatePort(f.deps).observe()).receipt, undefined);
    f.selection({ installable: true, selection_id: 's'+v, latest_version: String(+v+1) });
    assert.equal((await f.port.begin({ ...target, latest_version: String(+v+1), channel: 'beta' })).job.stage, 'downloading');
  }
  for (const stage of ['rolled_back']) { f.raw({ job_id: stage, stage, version: '3' }); assert.equal((await f.port.observe()).job, null); assert.equal((await f.port.begin({ ...target, latest_version: '4' })).job.stage, 'downloading'); }
  f.raw({ job_id: 'old', stage: 'completed', version: '1' }); assert.equal((await f.port.observe()).receipt, undefined);
});
test('structured errors only: broad Russian prose never means disk or permissions', async () => {
  const f = fixture();
  for (const [code, expected] of [['download_failed','download_failed'],['prepare_failed','install_failed'],['checksum','checksum'],['disk_full','disk_full'],['not_writable','not_writable'],['network','network'],['journal_invalid','journal_invalid'],['recovery_failed','recovery_required']]) {
    f.raw({ job_id:'x', stage:'error', error_code:code, error:'Проверьте сеть и свободное место. Проверьте права доступа и целостность' });
    assert.equal((await f.port.observe()).job.error, expected);
  }
});
test('native conflict, busy, legacy error reobserve actual job; unknown is neutral', async () => {
  const f = fixture();
  for (const fail of [{code:'conflict'}, {status:409}, 'Установка уже началась.']) {
    f.raw({job_id:'x',stage:'awaiting_exit'}); f.fail(fail); assert.equal((await f.port.install('x')).stage,'installing');
  }
  f.raw({job_id:'x',stage:'deferred',busy:['recording']}); f.fail({code:'busy'}); assert.equal((await f.port.install('x')).stage,'ready');
  f.raw({job_id:'x',stage:'ready'}); f.fail('English /secret'); await assert.rejects(f.port.install('x'), e => e.code === 'unavailable');
});
test('stale selection and verification unavailable are not unsupported', async () => {
  const f = fixture();
  for (const [selection, code] of [[{installable:false,install_error:'missing SHA256'},'verification_unavailable'],[{installable:true,selection_id:'s',latest_version:'3'},'stale_selection'],[{installable:true,latest_version:'2'},'stale_selection']]) {
    f.selection(selection); await assert.rejects(f.port.begin(target), e => e.code === code);
  }
});
test('storage denial is safe; partial deferred native response preserves pinned job and disables auto',async()=>{
 const f=fixture(); f.deps.storage={getItem(){throw Error();},setItem(){throw Error();}};
 f.version('2');f.raw({job_id:'t',stage:'completed',version:'2'});assert.equal((await f.port.observe()).receipt.outcome,'healthy');assert.equal((await f.port.observe()).receipt,undefined);
 f.raw({stage:'idle'});const begun=await f.port.begin(target);f.deps.install=async()=>({stage:'deferred',busy:['recording']});
 const job=await f.port.install(begun.job.id);assert.equal(job.id,begun.job.id);assert.equal(job.target.latest_version,'2');assert.equal(job.autoEligible,false);
});
test('native partial busy works in a follower whose observations came from another window',async()=>{
 const f=fixture();f.raw({job_id:'shared',stage:'ready',version:'2',channel:'beta'});f.deps.install=async()=>({stage:'deferred',busy:['recording']});
 const job=await f.port.install('shared');assert.equal(job.id,'shared');assert.equal(job.stage,'ready');assert.deepEqual(job.busy,['recording']);
});

test('dismissed saved failures never pin a newer release or a changed channel', async () => {
 const f=fixture(); f.raw({job_id:'failed-old',stage:'error',version:'2',channel:'stable',error_code:'download_failed'});
 const {createUpdateController}=await import('../src/utils/updateController.ts');
 const c=createUpdateController(f.port); await c.refresh(); assert.equal(c.getSnapshot().stage,'failed');
 c.reset(); await c.refresh(); assert.equal(c.getSnapshot().stage,'idle');
 assert.equal((await createUpdatePort(f.deps).observe()).job,null);
 f.selection({installable:true,selection_id:'fresh',latest_version:'3'});
 await c.begin({...target,channel:'beta',latest_version:'3'});
 assert.equal(c.getSnapshot().stage,'downloading'); assert.equal(c.getSnapshot().target.channel,'beta');
});
test('recovery is durable across observers and invokes the actual native recovery operation',async()=>{
 const f=fixture();f.raw({job_id:'broken',stage:'recovery_required',version:'2'});
 assert.equal((await f.port.observe()).receipt.outcome,'recovery_required');
 assert.equal((await createUpdatePort(f.deps).observe()).receipt.outcome,'recovery_required');
 let calls=0;f.deps.install=async id=>{assert.equal(id,'broken');calls++;return{job_id:id,stage:'awaiting_exit',version:'2'};};
 const {createUpdateController}=await import('../src/utils/updateController.ts');const c=createUpdateController(f.port);
 await c.refresh();await c.recover();assert.equal(calls,1);assert.equal(c.getSnapshot().stage,'installing');
});

test('manual installation suppresses obsolete failed download receipts',async()=>{
 const f=fixture();
 for(const [current,failed] of [['0.2.0-beta.4','0.2.0-beta.3'],['1.0.0','1.0.0-beta.9'],['3.0.0','2.0.0']]){
  f.version(current);f.raw({job_id:current,stage:'error',version:failed,error_code:'download_failed'});assert.equal((await f.port.observe()).job,null);
 }
 f.version('0.2.0-beta.2');f.raw({job_id:'needed',stage:'error',version:'0.2.0-beta.3',error_code:'download_failed'});assert.equal((await f.port.observe()).job.error,'download_failed');
});
