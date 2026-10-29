import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { UpdateJobView } = await import('../src/components/settings/UpdateJobView.tsx');
const { api, setUpdateInstalling } = await import('../src/services/api.ts');
const state = { stage: 'idle', initialized: true, supported: true, target: null, job: null, busy: [] };
const render = patch => renderToStaticMarkup(React.createElement(UpdateJobView, {
  state: { ...state, ...patch }, availableVersion: '2', status: 'Доступна 2', releaseUrl: 'https://github.com/almatkai/Steppe-Meeting/releases/tag/v2', checkDisabled: false,
  onBegin() {}, onInstall() {}, onCancel() {}, onCheck() {}, onManual() {}, onRecover() {},
}));
test('available primary, disabled busy ready, installing without actions, restricted manual fallback', () => {
  assert.match(render({}), /Обновить до 2/); assert.doesNotMatch(render({}), /Скачать вручную|Открыть релиз/);
  const busy = render({ stage: 'ready', busy: ['recording'] });
  assert.match(busy, /disabled="" aria-describedby="update-helper"/); assert.match(busy, /Аудио ещё используется/); assert.match(busy, /Отменить/);
  assert.doesNotMatch(render({ stage: 'installing' }), /<button/);
  assert.match(render({ supported: false }), /Скачать вручную/);
  assert.match(render({ stage: 'failed', error: 'checksum' }), /Повторить/);
  assert.match(render({ stage: 'failed', error: 'checksum' }), /Скачать вручную/);
  assert.doesNotMatch(render({ stage: 'failed', error: 'network' }), /Скачать вручную/);
});
test('progress actual bytes and percent; live announcements change only at quarter increments', () => {
  const job = { bytes: 48_000_000, total: 112_000_000 };
  const html = render({ stage: 'downloading', job });
  assert.match(html, /aria-valuenow="42"/); assert.match(html, /48 из 112 МБ · 42 %/);
  assert.match(html, /Загрузка обновления… 25 %/);
  assert.match(render({ stage: 'downloading', job: { bytes: 4_000_000 } }), /4 МБ/);
  assert.doesNotMatch(render({ stage: 'downloading', job: { bytes: 4_000_000 } }), /aria-valuenow=/);
});
test('errors assertive, all codes Russian and no raw backend details', () => {
  for (const error of ['network', 'checksum', 'disk_full', 'not_writable', 'busy', 'install_failed', 'interrupted']) {
    const html = render({ stage: 'failed', error, job: { error: '/private/stack ENGLISH' } });
    assert.match(html, /role="alert" aria-live="assertive"/); assert.doesNotMatch(html, /private|ENGLISH/);
  }
});
test('critical-install global frontend flag refuses new API work before any fetch', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('must not run'); };
  try {
    setUpdateInstalling(true);
    for (const action of [() => api.startRecordingSession('fake'), () => api.generate('fake'), () => api.transcribe('fake')]) await assert.rejects(action(), /Дождитесь перезапуска/);
    assert.equal(calls, 0);
  } finally { setUpdateInstalling(false); globalThis.fetch = original; }
});
test('capture fence serializes and retains native lock until all users finish; refused acquisition never returns a lease', async () => {
  const { createCaptureFence } = await import('../src/utils/updateCapture.ts');
  const calls = [];
  const acquire = createCaptureFence({ acquire: async () => calls.push('acquire'), release: async () => calls.push('release'), announce: () => calls.push('activity') });
  const [first, second] = await Promise.all([acquire(), acquire()]);
  await first(); assert.deepEqual(calls, ['activity', 'activity', 'acquire']);
  await second(); await second(); assert.equal(calls.filter(x => x === 'release').length, 1);
  const denied = createCaptureFence({ acquire: async () => { throw Error('installing'); }, release: async () => assert.fail(), announce() {} });
  await assert.rejects(denied(), /installing/);
});
test('recovery and uncertain capability use honest copy; persistent live regions; cancel failure visible',()=>{
 const recovery=render({stage:'failed',error:'recovery_required'});assert.match(recovery,/Требуется восстановление/);assert.match(recovery,/Скачать вручную/);assert.doesNotMatch(recovery,/Предыдущая версия сохранена|Повторить/);
 assert.doesNotMatch(render({initialized:false,supported:false,error:'network'}),/Скачать вручную|поддерживаемой сборке/);
 const cancellation=render({stage:'downloading',error:'network',job:{bytes:10,cancellable:true}});assert.match(cancellation,/Не удалось загрузить/);assert.doesNotMatch(cancellation,/Установить и перезапустить/);
 for(const patch of [{},{stage:'failed',error:'checksum'}]) {const html=render(patch);assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/role="alert" aria-live="assertive"/);}
});
test('production draft owner keeps explicit updater installation fenced until upload accepts',async()=>{
 const {createAudioDraftOwner}=await import('../src/utils/audioDraftOwner.ts');
 const {createUpdateController}=await import('../src/utils/updateController.ts');
 let locked=false, installs=0;
 const acquire=async()=>{locked=true;return async()=>{locked=false;}};
 const owner=createAudioDraftOwner(acquire), file={};
 const job={id:'x',stage:'ready',target:{latest_version:'2'},busy:[],autoEligible:false};
 const controller=createUpdateController({observe:async()=>({supported:true,job,busy:locked?['recording']:[]}),install:async()=>{installs++;return {...job,stage:'installing'};}});
 await owner.retain('record',file,await acquire()); await controller.refresh();await controller.install();assert.equal(installs,0);
 await assert.rejects(owner.upload(file,async()=>{throw Error();}));await controller.refresh();await controller.install();assert.equal(installs,0);
 await owner.upload(file,async()=>{});await controller.refresh();assert.equal(installs,0);await controller.install();assert.equal(installs,1);
});

test('unresolved recovery remains actionable and retries display the current release',()=>{
 const html=render({stage:'failed',error:'recovery_required',receipt:{id:'tx',outcome:'recovery_required',version:'1'}});
 assert.match(html,/Восстановить предыдущую версию/);assert.match(html,/Скачать вручную/);
 assert.doesNotMatch(html,/Обновить до|>Повторить</);
 assert.match(render({stage:'failed',error:'download_failed',target:{latest_version:'1'}}),/Повторить/);
});

test('recovery has a manual exit even with an up-to-date tracker and no release URL',async()=>{
 const {updateDownloadUrl}=await import('../src/utils/updateController.ts');
 const recovery={...state,stage:'failed',error:'recovery_required',receipt:{id:'broken',version:'2',outcome:'recovery_required'}};
 assert.equal(updateDownloadUrl(recovery,null),'https://github.com/almatkai/Steppe-Meeting/releases');
 const html=renderToStaticMarkup(React.createElement(UpdateJobView,{state:recovery,status:'Установлена последняя версия',releaseUrl:null,checkDisabled:false,onBegin(){},onInstall(){},onCancel(){},onCheck(){},onManual(){},onRecover(){}}));
 assert.match(html,/Скачать вручную/);assert.match(html,/Восстановить предыдущую версию/);
 assert.equal(updateDownloadUrl(state,null),null);
 const busy=render({...recovery,error:'busy'});assert.doesNotMatch(busy,/>Повторить</);
});
