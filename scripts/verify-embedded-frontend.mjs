// Prove the tested shipping JavaScript is embedded in the signed executable.
// No app is launched. Cargo's exact Brotli bytes must occur in the Mach-O and
// decode byte-for-byte to dist; a source/stamp hash alone is insufficient.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const binaryPath = join(root, 'src-tauri/target/release/bundle/macos/Steppe Meeting.app/Contents/MacOS/steppe-desktop');
const binary = await readFile(binaryPath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const candidates = (await files(join(root, 'src-tauri/target/release/build'))).filter(p => p.includes('/tauri-codegen-assets/') && p.endsWith('.js'));
const sources = (await files(join(root, 'dist'))).filter(p => p.endsWith('.js'));
assert.ok(sources.length && candidates.length, 'Missing shipping assets');
const matched = new Map();
for (const path of candidates) {
  const compressed = await readFile(path), offset = binary.indexOf(compressed);
  if (offset < 0) continue;
  let bytes;
  try { bytes = brotliDecompressSync(compressed); } catch { bytes = compressed; }
  matched.set(hash(bytes), { bytes, offset, length: compressed.length, encoding: bytes === compressed ? 'identity' : 'br' });
}
const assets = [];
for (const path of sources) {
  const bytes = await readFile(path), digest = hash(bytes), embedded = matched.get(digest);
  assert.ok(embedded && embedded.bytes.equals(bytes), 'Shipping JS absent from executable: ' + path);
  assets.push({ path: relative(join(root, 'dist'), path), sha256: digest, offset: embedded.offset, length: embedded.length, encoding: embedded.encoding });
}
const output = join(root, 'build/embedded-frontend');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'dist'), output, { recursive: true });
// These bytes are recovered from the actual executable, not copied from source.
for (const asset of assets) {
  const embedded = binary.subarray(asset.offset, asset.offset + asset.length);
  const decoded = asset.encoding === 'br' ? brotliDecompressSync(embedded) : embedded;
  assert.equal(hash(decoded), asset.sha256);
  await writeFile(join(output, asset.path), decoded);
}
await writeFile(join(root, 'build/embedded-frontend-verification.json'), JSON.stringify({ result: 'PASS', binary_sha256: hash(binary), assets, scope: 'shipping JS recovered byte-for-byte from signed production Mach-O; supporting HTML/CSS from tested dist' }, null, 2) + '\n');
console.log('PASS: ' + assets.length + ' shipping JavaScript assets recovered from signed executable');
