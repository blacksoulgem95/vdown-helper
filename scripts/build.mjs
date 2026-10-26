// Builds the extension into dist/: pages, service worker, content script, then copies static files.
// Runs TypeScript via Node's native type stripping for vite.shared.ts.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

// vite.shared.ts is loaded through Node's built-in TypeScript support (unflagged since 22.18).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Node ${process.versions.node} is too old: this build needs Node 22.18 or newer.`);
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const { pagesConfig, backgroundConfig, contentConfig, hookConfig, DIST } = await import(
  resolve(root, 'vite.shared.ts')
);

await build(pagesConfig());
await build(backgroundConfig());
await build(contentConfig());
await build(hookConfig());

// Manifest (version is sourced from package.json so there is a single source of truth).
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
// CI sets VDH_VERSION to the version it is releasing; otherwise package.json decides (local builds).
const version = process.env.VDH_VERSION ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version "${version}": expected x.y.z`);
manifest.version = version;
writeFileSync(resolve(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

cpSync(resolve(root, '_locales'), resolve(DIST, '_locales'), { recursive: true });

// FFmpeg.wasm core, bundled locally. Never fetched from a CDN (remote code is not allowed).
const coreDir = resolve(root, 'node_modules/@ffmpeg/core/dist/esm');
const vendor = resolve(DIST, 'vendor/ffmpeg');
mkdirSync(vendor, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const src = resolve(coreDir, f);
  if (!existsSync(src)) throw new Error(`Missing ${src}; run npm install`);
  cpSync(src, resolve(vendor, f));
}
console.log('vdown-helper built ->', DIST);
