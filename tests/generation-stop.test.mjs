import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Same dependency-free TSX/SSR harness used by cli-readiness-ui.test.mjs.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.conditions.includes('import')) {
      const resolved = next(specifier, context);
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(
        `import React from ${JSON.stringify(resolved.url)}; export * from ${JSON.stringify(resolved.url)};
         export const useSyncExternalStore = (s,g) => React.useSyncExternalStore(s,g,g);
         export default {...React,useSyncExternalStore};`) };
    }
    if (specifier === 'file-saver') {
      const resolved = next(specifier, context);
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(
        `import saver from ${JSON.stringify(resolved.url)}; export const saveAs=saver.saveAs;`) };
    }
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).outputText };
    return next(url, context);
  },
});
const { MeetingDetailView } = await import('../src/components/meeting/MeetingDetailView.tsx');
const { HistoryView } = await import('../src/components/history/HistoryView.tsx');
const { useMeetingStore } = await import('../src/store/useMeetingStore.ts');
const { api } = await import('../src/services/api.ts');
const meeting = (id = 'a', status = 'generating') => ({ id, title: 'Synthetic', status, source_language: 'ru',
  created_at: '2026-10-28', transcript_text: 'Preserved transcript', transcript_segments: [],
  protocol_ru: { title: 'Preserved protocol' }, protocol_kz: {}, summary_ru: {}, summary_kz: {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const restoreStore = useMeetingStore.getState();
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join('')
  : typeof node === 'object' ? text(node.props?.children) : String(node);
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child,predicate); if (found) return found; } return; }
  if (predicate(node)) return node;
  return find(node.props?.children,predicate);
}
const button = (tree, name) => find(tree, el => el.type === 'button' && text(el) === name);

// Exercise actual client hook event handlers across renders without adding a
// browser/DOM dependency. Effects run after commit; host refs get a focus spy.
function mount() {
  const slots = []; let cursor, effects, tree, focused;
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const memo = (fn, deps) => {
    const i=cursor++, previous=slots[i];
    if (!previous || !deps || deps.some((v,j)=>!Object.is(v,previous.deps[j]))) slots[i]={deps,value:fn()};
    return slots[i].value;
  };
  const dispatcher = {
    useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=typeof initial==='function'?initial():initial;
      return [slots[i], value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}]; },
    useRef(initial) { const i=cursor++; return slots[i] ??= {current:initial}; },
    useEffect(fn,deps) { memo(()=>{ effects.push(fn); },deps); },
    useCallback(fn,deps) { return memo(()=>fn,deps); }, useMemo:memo,
    useSyncExternalStore(_subscribe,get) { return get(); }, useDebugValue() {},
  };
  return {
    render() {
      cursor=0; effects=[]; const previous=internals.H; internals.H=dispatcher;
      try { tree=MeetingDetailView(); } finally { internals.H=previous; }
      const rerun=button(tree,'Сформировать протокол заново');
      if (rerun?.props.ref) rerun.props.ref.current={focus(){focused='rerun';}};
      // Polling effects are exercised with fake timers by the owning test.
      for (const effect of effects) effect();
      return tree;
    },
    get focused() { return focused; },
  };
}

test('Generating and terminal UI render real accessible Stop/rerun controls and neutral history status', () => {
  try {
    useMeetingStore.setState({activeMeeting:meeting(),activeMeetingId:'a'});
    const html=renderToStaticMarkup(React.createElement(MeetingDetailView));
    assert.match(html,/Остановить/); assert.match(html,/role="status" aria-live="polite"/);
    assert.match(html,/focus-visible:ring-2/);
    useMeetingStore.setState({activeMeeting:meeting('a','cancelled'),meetings:[meeting('a','cancelled')]});
    const stopped=renderToStaticMarkup(React.createElement(MeetingDetailView));
    assert.match(stopped,/Остановлено/); assert.match(stopped,/Генерация протокола остановлена/);
    assert.match(stopped,/Сформировать протокол заново/); assert.doesNotMatch(stopped,/>Остановить</);
    assert.match(renderToStaticMarkup(React.createElement(HistoryView)),/Остановлено/);
  } finally {useMeetingStore.setState(restoreStore);}
});

test('One click stops once; polling cannot replace pending card; selected tab/results survive and rerun receives focus', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const done=deferred(); let calls=0, polls=0;
  try {
    useMeetingStore.setState({activeMeeting:meeting(),activeMeetingId:'a',
      refreshActiveMeeting:async()=>{polls++;}, stopGeneration:async id=>{assert.equal(id,'a');calls++;await done.promise;}});
    const h=mount(); let tree=h.render();
    button(tree,'Краткое резюме и задачи').props.onClick(); tree=h.render();
    const stop=button(tree,'Остановить'); const pending=stop.props.onClick();
    await stop.props.onClick(); assert.equal(calls,1);
    useMeetingStore.setState({activeMeeting:meeting('a','cancelled')});
    tree=h.render();
    assert.equal(button(tree,'Останавливаем…').props.disabled,true);
    assert.equal(button(tree,'Сформировать протокол заново'),undefined);
    t.mock.timers.tick(3000); assert.ok(polls>0);
    assert.ok(find(tree,el=>el.props.summaryRu));
    done.resolve();await pending;tree=h.render();
    assert.ok(button(tree,'Сформировать протокол заново')); assert.equal(h.focused,'rerun');
    assert.ok(find(tree,el=>el.props.summaryRu));
    assert.equal(useMeetingStore.getState().activeMeeting.transcript_text,'Preserved transcript');
  } finally {useMeetingStore.setState(restoreStore);}
});

test('Stop failure stays inline and Retry uses the same meeting; a different selection ignores old completion/error', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const old=deferred();let calls=0;
  try {
    useMeetingStore.setState({activeMeeting:meeting(),activeMeetingId:'a',stopGeneration:async()=>{
      calls++; if(calls===1) {
        useMeetingStore.setState({activeMeeting:{...meeting('a','error'),error_message:'Synthetic cleanup failure'}});
        throw new Error('Synthetic cleanup failure');
      } await old.promise;
    }});
    const h=mount();let tree=h.render();
    await button(tree,'Остановить').props.onClick();tree=h.render();
    assert.match(text(tree),/Не удалось остановить. Synthetic cleanup failure/);
    assert.doesNotMatch(text(tree),/Ошибка во время обработки/);
    const retry=button(tree,'Повторить').props.onClick();tree=h.render();
    assert.equal(button(tree,'Останавливаем…').props.disabled,true);
    useMeetingStore.setState({activeMeeting:meeting('b'),activeMeetingId:'b'});tree=h.render();
    assert.ok(button(tree,'Остановить'));
    old.reject(new Error('Late error from a'));await retry;tree=h.render();
    assert.doesNotMatch(text(tree),/Late error|Не удалось остановить/);
    assert.ok(button(tree,'Остановить'));
  } finally {useMeetingStore.setState(restoreStore);}
});

test('Store discards out-of-order polls and responses from other selections, including during Stop', async () => {
  const originalGet=api.getMeeting, originalStop=api.stopGeneration;
  try {
    useMeetingStore.setState({...restoreStore,activeMeetingId:'a',activeMeeting:meeting()});
    const old=deferred(),fresh=deferred();let calls=0;
    api.getMeeting=()=>++calls===1?old.promise:fresh.promise;
    const p1=useMeetingStore.getState().refreshActiveMeeting(),p2=useMeetingStore.getState().refreshActiveMeeting();
    fresh.resolve(meeting('a','cancelled'));await p2;old.resolve(meeting());await p1;
    assert.equal(useMeetingStore.getState().activeMeeting.status,'cancelled');
    const stop=deferred(),selected=deferred();api.stopGeneration=()=>stop.promise;
    const pending=useMeetingStore.getState().stopGeneration('a');
    api.getMeeting=()=>selected.promise;
    const selection=useMeetingStore.getState().selectMeeting('b');
    stop.resolve({meeting_id:'a',status:'cancelled'});await pending;
    selected.resolve(meeting('b','completed'));await selection;
    assert.equal(useMeetingStore.getState().activeMeeting.id,'b');
    assert.equal(useMeetingStore.getState().isLoading,false);
    const stale=deferred();api.getMeeting=()=>stale.promise;
    const poll=useMeetingStore.getState().refreshActiveMeeting();
    useMeetingStore.getState().setActiveMeetingId(null);
    stale.resolve(meeting('b'));await poll;
    assert.equal(useMeetingStore.getState().activeMeeting,null);
  } finally {api.getMeeting=originalGet;api.stopGeneration=originalStop;useMeetingStore.setState(restoreStore);}
});

test('Stop API waits for the bounded server acknowledgement and reflects server errors', async () => {
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url,options)=>{
      assert.match(url,/meetings\/captured-id\/stop-generation$/);
      assert.equal(options.method,'POST');assert.ok(options.signal);
      return new Response(JSON.stringify({meeting_id:'captured-id',status:'cancelled'}));
    };
    assert.equal((await api.stopGeneration('captured-id')).status,'cancelled');
    globalThis.fetch=async()=>new Response(JSON.stringify({detail:'Cleanup pending'}),{status:504});
    await assert.rejects(api.stopGeneration('captured-id'),/Cleanup pending/);
  } finally {globalThis.fetch=original;}
});

test('Selecting a meeting preserves the prior view until success and on fetch failure', async () => {
  const originalGet=api.getMeeting;
  const originalError=console.error;
  try {
    console.error=()=>{};
    useMeetingStore.setState({...restoreStore,activeMeetingId:'a',activeMeeting:meeting(),currentView:'history'});
    const next=deferred();api.getMeeting=()=>next.promise;
    const selection=useMeetingStore.getState().selectMeeting('b');
    assert.equal(useMeetingStore.getState().activeMeeting.id,'a');
    assert.equal(useMeetingStore.getState().currentView,'history');
    next.reject(new Error('Synthetic unavailable meeting'));await selection;
    assert.equal(useMeetingStore.getState().activeMeeting.id,'a');
    assert.equal(useMeetingStore.getState().currentView,'history');
    assert.equal(useMeetingStore.getState().isLoading,false);
  } finally {console.error=originalError;api.getMeeting=originalGet;useMeetingStore.setState(restoreStore);}
});
