// Actual shipping React UI; every HTTP request is intercepted before a socket
// can reach the real backend. No CLI, settings write, STT or installer is used.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const args = parseArgs({ options: { dist: { type: 'string', default: 'dist' }, out: { type: 'string', default: 'build/generation-retry-ui' } } });
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, args.values.dist), out = resolve(root, args.values.out);
const browser = await chromium.launch({ headless: true, executablePath: process.env.STEPPE_SMOKE_CHROMIUM || undefined });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 940 } });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const route = (provider, model = '', mode = 'cli') => ({ mode, provider, model });
const attempt = { ...route('opencode', 'prov/failed#free'), id: 'failed', started_at: '2026-10-30T12:00:00Z' };
const options = {
  default: route('opencode', 'saved/default'), last_attempt: attempt,
  providers: [
    { ...route('api', 'saved-api', 'api'), label: 'API из настроек', requires_model: true, supports_models: true },
    { ...route('opencode', 'saved/default'), label: 'OpenCode', requires_model: true, supports_models: true },
    { ...route('codex'), label: 'Codex CLI', requires_model: false, supports_models: false },
    { ...route('claude'), label: 'Claude Code', requires_model: false, supports_models: false },
    { ...route('antigravity'), label: 'Antigravity', requires_model: false, supports_models: true },
  ],
};
let meeting = {
  id: 'fake-retry', title: 'Синтетическая встреча', created_at: '2026-10-30T12:00:00Z', status: 'error', duration_seconds: 65,
  source_language: 'multi', agenda: '', participants: [], audio_filename: 'synthetic.webm', transcript_text: 'Сохранённая стенограмма для проверки интерфейса.',
  transcript_segments: [{ id: 's', speaker: 'Спикер 1', text: 'Сохранённая стенограмма для проверки интерфейса.', timestamp_start: 0, timestamp_end: 65 }],
  protocol_ru: {}, protocol_kz: {}, summary_ru: {}, summary_kz: {}, error_message: 'OpenCode отклонил запрос (429).', generation_attempt: attempt,
};
const calls = [], violations = [], errors = [], checks = [];
let rejectStart = true, holdStart, releaseStart, failRefresh = false;
page.on('pageerror', error => errors.push(String(error)));
await context.route('**/*', async requestRoute => {
  const request = requestRoute.request(), url = new URL(request.url()), path = url.pathname;
  if (url.origin === 'https://retry.invalid') {
    const file = resolve(dist, decodeURIComponent(path).replace(/^\//, '') || 'index.html');
    assert.ok(file.startsWith(dist + '/'));
    return requestRoute.fulfill({ body: await readFile(file), contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
  }
  if (url.origin !== 'http://127.0.0.1:8008') { violations.push(request.url()); return requestRoute.abort(); }
  calls.push({ method: request.method(), path, query: Object.fromEntries(url.searchParams), body: request.postData() });
  let value;
  if (request.method() === 'POST' && path === '/api/v1/meetings/fake-retry/generate') {
    if (rejectStart) { rejectStart = false; return requestRoute.fulfill({ status: 422, json: { detail: 'Модель временно недоступна' }, headers: { 'access-control-allow-origin': '*' } }); }
    if (holdStart) await holdStart;
    const selected = request.postData() ? JSON.parse(request.postData()) : options.default;
    meeting = { ...meeting, status: 'generating', error_message: '', generation_attempt: { ...selected, id: 'accepted', started_at: new Date().toISOString() } };
    failRefresh = true;
    return requestRoute.fulfill({ json: { meeting_id: meeting.id, status: 'generating', generation_attempt: meeting.generation_attempt }, headers: { 'access-control-allow-origin': '*' } });
  }
  if (request.method() !== 'GET') { violations.push(request.method() + ' ' + path); return requestRoute.abort(); }
  if (path === '/api/v1/meetings') value = [meeting];
  else if (path === '/api/v1/meetings/fake-retry') {
    if (failRefresh) return requestRoute.fulfill({ status: 500, json: { detail: 'Synthetic GET failure' }, headers: { 'access-control-allow-origin': '*' } });
    value = meeting;
  } else if (path.endsWith('/generation-options')) value = options;
  else if (path.endsWith('/generation-models')) value = { provider: url.searchParams.get('provider') || 'api', models: [{ id: 'prov/listed', name: 'Listed model', provider: 'prov', free: true }], pricing_available: true, fetched_at: '2026-10-30T12:00:00Z' };
  else if (path === '/api/v1/system/config') value = { update_channel: 'beta' };
  else if (path === '/api/v1/system/updates') value = { status: 'up_to_date', channel: 'beta', current_version: url.searchParams.get('current_version'), checked_at: new Date().toISOString() };
  else if (path === '/api/v1/system/status') value = { ollama: {}, whisper: {} };
  else if (path === '/api/v1/templates') value = [];
  else { violations.push('GET ' + path); return requestRoute.abort(); }
  return requestRoute.fulfill({ json: value, headers: { 'access-control-allow-origin': '*' } });
});

try {
  await page.goto('https://retry.invalid/?meeting=fake-retry');
  const toggle = page.getByRole('button', { name: 'Другой провайдер или модель' });
  await toggle.click();
  const provider = page.getByLabel('Провайдер', { exact: true }), model = page.getByLabel('Модель', { exact: true });
  await provider.waitFor(); assert.equal(await provider.inputValue(), 'cli:opencode');
  assert.equal(await model.inputValue(), 'prov/failed#free');
  assert.equal(await provider.evaluate(el => el === document.activeElement), true);
  await page.getByText('Последняя попытка: OpenCode · prov/failed#free', { exact: true }).waitFor();
  checks.push('actual failed model and provider; focus on provider; saved default distinct');
  await model.fill('prov/new#high'); await model.press('Enter');
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  await provider.selectOption('cli:claude'); await model.fill('claude-draft');
  await provider.selectOption('cli:opencode'); assert.equal(await model.inputValue(), 'prov/new#high');
  await page.getByRole('button', { name: 'Загрузить модели', exact: true }).click();
  await page.getByText(/Получено моделей: 1/).waitFor();
  assert.equal(await model.inputValue(), 'prov/new#high');
  await page.getByRole('option', { name: 'prov/new#high (нет в загруженном списке)', exact: true }).count().then(n => assert.equal(n, 1));
  checks.push('draft and exact variant survive provider switches and model discovery; no auto start');
  await provider.selectOption('api:api'); await model.fill('');
  assert.equal(await page.getByRole('button', { name: 'Запустить: API из настроек · модель не указана', exact: true }).isEnabled(), false);
  await provider.selectOption('cli:codex'); assert.equal(await model.inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Загрузить модели', exact: true }).count(), 0);
  const start = page.getByRole('button', { name: 'Запустить: Codex CLI · модель по умолчанию', exact: true });
  const quick = page.getByRole('button', { name: 'Повторить генерацию', exact: true });
  assert.ok(!(await quick.getAttribute('class')).includes('bg-white'));
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: join(out, 'expanded-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 760, height: 1000 });
  assert.equal(await page.locator('#gen-route-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.ok((await page.getByRole('button', { name: 'AI Ассистент', exact: true }).boundingBox()).x + (await page.getByRole('button', { name: 'AI Ассистент', exact: true }).boundingBox()).width <= 760);
  await page.screenshot({ path: join(out, 'expanded-narrow.png'), fullPage: true });
  await start.click(); await page.getByRole('alert').filter({ hasText: 'Не удалось запустить: Модель временно недоступна' }).waitFor();
  assert.equal(await model.inputValue(), '');
  assert.equal(await start.evaluate(el => el === document.activeElement), true);
  checks.push('API validation; only one primary retry; no unsupported model-list action; inline 422 and focus preserved');
  holdStart = new Promise(resolve => { releaseStart = resolve; });
  await start.click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(el => el.textContent === 'Повторить генерацию')?.disabled);
  assert.equal(await quick.isEnabled(), false); assert.equal(await provider.isEnabled(), false);
  await quick.evaluate(el => el.click());
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
  releaseStart();
  await page.getByRole('button', { name: 'Остановить', exact: true }).waitFor();
  assert.equal(await page.locator('#gen-route-panel').count(), 0);
  await page.getByText('Сохранённая стенограмма для проверки интерфейса.', { exact: true }).waitFor();
  checks.push('shared quick/panel lock; accepted job exposes Stop even if GET fails; transcript/tab preserved');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body)), [route('codex'), route('codex')]);
  meeting = { ...meeting, status: 'error' }; failRefresh = false;
  await page.reload(); await page.getByRole('button', { name: 'Повторить генерацию', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить', exact: true }).waitFor();
  assert.equal(calls.filter(call => call.method === 'POST').at(-1).body, null);
  checks.push('collapsed quick retry preserves no-body default route');
  assert.ok(!calls.some(call => call.path.includes('/transcribe') || (call.path === '/api/v1/system/config' && call.method === 'POST')));
  assert.deepEqual(violations, []); assert.deepEqual(errors, []);
  await writeFile(join(out, 'receipt.json'), JSON.stringify({ result: 'PASS', scope: 'shipping React UI; all HTTP intercepted; no real backend/CLI/model/settings calls', checks, requests: calls }, null, 2) + '\n');
  console.log('PASS generation retry shipping UI:', checks.length, 'scenarios');
} finally { releaseStart?.(); await context.close(); await browser.close(); }
