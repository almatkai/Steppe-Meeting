// Run the unmodified shipping index/assets in an isolated browser. All HTTP and
// native IPC are allowlisted fakes; no backend, download or installer can run.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dist = resolve(args.includes('--dist') ? args[args.indexOf('--dist') + 1] : join(root, 'dist'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('TAURI_ENV_')) delete env[key];
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: root, env, encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}
if (!args.includes('--dist')) run(process.env.PYTHON || 'python3', ['-c', "import importlib.util; s=importlib.util.spec_from_file_location('beta','scripts/build-beta.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.frontend_build()"]);
const version = JSON.parse(await readFile(join(root, 'package.json'))).version;
const candidate = '99.0.0-beta.1';
const reports = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.STEPPE_SMOKE_CHROMIUM || undefined, timeout: 30000 });
async function check(name, assets, { native = true, mini = false, supported = true, platform = 'darwin', arch = 'aarch64' } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const requests = [], violations = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await context.addInitScript(({ native, version }) => {
    window.__smokeIPC = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    if (native) window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async command => {
        window.__smokeIPC.push(command);
        if (command === 'plugin:app|version') return version;
        if (command === 'ensure_backend') return;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return;
        throw new Error('Forbidden native IPC: ' + command);
      },
    };
  }, { native, version });
  // Every request is intercepted before any socket is opened, including 8008.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://shipping.invalid') {
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      const file = resolve(assets, relative);
      assert.ok(file.startsWith(assets + '/'), file);
      const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
      return route.fulfill({ body: await readFile(file), contentType });
    }
    const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:8008' || request.method() !== 'GET') {
      violations.push(request.method() + ' ' + url.origin + path); return route.abort();
    }
    let value;
    if (path === '/api/v1/system/updates') {
      requests.push(Object.fromEntries(url.searchParams));
      value = { status: 'available', repository: 'almatkai/Steppe-Meeting', current_version: url.searchParams.get('current_version'), channel: 'beta', latest_version: candidate, checked_at: new Date().toISOString(), release_url: 'https://github.com/almatkai/Steppe-Meeting/releases/tag/v' + candidate, installable: true, selection_id: 'fake-read-only-selection' };
    } else if (path === '/api/v1/system/updates/job') value = { stage: 'idle', busy: [] };
    else if (path === '/api/v1/system/config') value = { update_channel: 'beta', llm_mode: 'cli', llm_cli_provider: 'codex', llm_cli: { codex: {}, claude: {}, gemini: {}, opencode: {} }, llm_base_url: 'http://localhost:11434/v1', llm_api_key: '', llm_model: '', whisper_mode: 'local', whisper_local_model: 'small', whisper_device: 'auto', whisper_base_url: 'http://localhost:8000/v1', whisper_model: 'whisper-1', whisper_api_key: '' };
    else if (path === '/api/v1/system/status') value = { ollama: {}, whisper: { local: { catalog: [] } } };
    else if (path === '/api/v1/system/whisper/status') value = { local: { catalog: [] } };
    else if (['/api/v1/meetings', '/api/v1/templates'].includes(path)) value = [];
    else if (path.endsWith('/models')) value = { models: [] };
    else { violations.push('Unexpected GET ' + path); return route.abort(); }
    return route.fulfill({ json: value, headers: { 'access-control-allow-origin': '*' } });
  });
  try {
    await page.goto('https://shipping.invalid/' + (mini ? '?mode=mini' : ''));
    if (!mini) {
      await page.getByRole('button', { name: 'Настройки AI', exact: true }).click();
      const card = page.locator('section[aria-labelledby="updates-title"]');
      await card.getByText('Доступна ' + candidate, { exact: false }).first().waitFor();
      // Await observation initialization too; unsupported must not pass on loading.
      await page.waitForFunction(() => document.querySelector('#update-helper')?.textContent !== '');
      const update = card.getByRole('button', { name: 'Обновить до ' + candidate, exact: true });
      const text = await card.innerText();
      assert.equal(await update.count(), supported ? 1 : 0, name + ': real update button missing/wrong capability; ' + text);
      if (supported) assert.equal(await update.isEnabled(), true, name + ': primary disabled');
      else await card.getByRole('button', { name: 'Скачать вручную', exact: true }).waitFor();
      assert.ok(requests.length, name + ': no actual release request');
      if (native) for (const query of requests) {
        assert.equal(query.platform, platform, name + ': platform query');
        assert.equal(query.arch, arch, name + ': arch query');
        assert.equal(query.current_version, version);
      }
    } else {
      await page.locator('#root > *').waitFor();
      assert.equal(await page.getByRole('button', { name: /^Обновить до / }).count(), 0);
      assert.equal(requests.length, 0, 'Mini must not run release checks');
    }
    assert.deepEqual(violations, [], name + ': unexpected transport');
    assert.deepEqual(errors, [], name + ': frontend errors');
    const ipc = await page.evaluate(() => window.__smokeIPC);
    assert.ok(!ipc.includes('install_update'));
    reports.push({ name, result: 'PASS', supported, query: requests[0] || null, real_shipping_ui: true, native_ipc: ipc });
    console.log('PASS shipping frontend: ' + name);
  } catch (error) {
    console.error(JSON.stringify({ name, requests, violations, errors, text: await page.locator('body').innerText() }));
    throw error;
  } finally { await context.close(); }
}
let temporary;
try {
  await check('production native macOS arm64 main', dist);
  await check('production browser', dist, { native: false, supported: false });
  await check('production Mini', dist, { mini: true, supported: false });
  if (args.includes('--matrix')) {
    temporary = await mkdtemp(join(tmpdir(), 'steppe-frontend-gate-'));
    for (const [name, platform, arch, dev] of [['unsupported architecture', 'darwin', 'x86_64', false], ['unsupported platform', 'linux', 'aarch64', false], ['missing target identity', '', '', false], ['development', 'darwin', 'aarch64', true]]) {
      const output = join(temporary, name.replaceAll(' ', '-'));
      const argv = dev
        ? ['--input-type=module', '-e', `import {build} from 'vite'; await build({build:{outDir:process.argv[1]},define:{'import.meta.env.PROD':false}})`, output]
        : ['node_modules/vite/bin/vite.js', 'build', '--outDir', output];
      run('node', argv, { env: { ...env, TAURI_ENV_PLATFORM: platform, TAURI_ENV_ARCH: arch } });
      await check(name, output, { platform, arch, supported: false });
    }
  }
  await mkdir(join(root, 'build'), { recursive: true });
  const receipt = args.includes('--receipt') ? resolve(args[args.indexOf('--receipt') + 1]) : join(root, 'build/shipping-frontend-smoke.json');
  await writeFile(receipt, JSON.stringify({ result: 'PASS', version, scope: 'actual shipping index/assets; read-only fake HTTP and native IPC; no download/install', reports }, null, 2) + '\n');
} finally {
  await browser.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
