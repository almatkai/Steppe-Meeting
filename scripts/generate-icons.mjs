// Tauri's SVG icon renderer uses resvg. Keep all outputs derived from vectors.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temporary = mkdtempSync(join(tmpdir(), 'steppe-icons-'));
const tauri = (...args) => execFileSync('pnpm', ['exec', 'tauri', 'icon', ...args], { stdio: 'inherit' });
try {
  tauri('src-tauri/icons/icon-source.svg', '--png', '1024', '--output', temporary);
  copyFileSync(join(temporary, '1024x1024.png'), 'src-tauri/icons/icon-1024.png');
  tauri('src-tauri/icons/icon-1024.png');
  tauri('public/steppe-icon.svg', '--png', '512', '--output', temporary);
  copyFileSync(join(temporary, '512x512.png'), 'public/steppe-icon.png');
  for (const file of readdirSync('src-tauri/icons')) {
    if (/^(Square.*Logo|StoreLogo)\.png$/.test(file)) rmSync(join('src-tauri/icons', file));
  }
  // Desktop bundles do not use these extra targets.
  for (const target of ['android', 'ios']) rmSync(join('src-tauri/icons', target), { recursive: true, force: true });
} finally { rmSync(temporary, { recursive: true, force: true }); }
