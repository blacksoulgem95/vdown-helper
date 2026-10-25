// Builds the extension into dist/: pages, service worker, content script, then copies static files.
// Runs TypeScript via Node's native type stripping for vite.shared.ts.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const { pagesConfig, backgroundConfig, contentConfig, DIST } = await import(resolve(root, 'vite.shared.ts'));

await build(pagesConfig());
await build(backgroundConfig());
await build(contentConfig());

// Manifest (version is sourced from package.json so there is a single source of truth).
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(resolve(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

cpSync(resolve(root, '_locales'), resolve(DIST, '_locales'), { recursive: true });

// FFmpeg.wasm core, bundled locally. Never fetched from a CDN (remote code is not allowed).
const coreDir = resolve(root, 'node_modules/@ffmpeg/core/dist/umd');
const vendor = resolve(DIST, 'vendor/ffmpeg');
mkdirSync(vendor, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const src = resolve(coreDir, f);
  if (!existsSync(src)) throw new Error(`Missing ${src}; run npm install`);
  cpSync(src, resolve(vendor, f));
}
console.log('vdown-helper built ->', DIST);
