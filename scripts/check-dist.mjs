// Validates the built extension in dist/: manifest references, assets, locale keys, CSP-safe HTML, no remote code.
// Exit code 1 on any problem. Run after `npm run build`.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const problems = [];
const fail = (m) => problems.push(m);

function read(p) {
  return readFileSync(join(dist, p), 'utf8');
}
function need(p, why) {
  if (!p) return;
  if (!existsSync(join(dist, p))) fail(`missing file ${p} (${why})`);
}

if (!existsSync(dist)) {
  console.error('dist/ not found; run npm run build first');
  process.exit(1);
}

const manifest = JSON.parse(read('manifest.json'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`invalid version ${manifest.version}`);

for (const [size, p] of Object.entries(manifest.icons ?? {})) need(p, `icon ${size}`);
for (const p of Object.values(manifest.action?.default_icon ?? {})) need(p, 'action icon');
need(manifest.action?.default_popup, 'popup');
need(manifest.background?.service_worker, 'service worker');
need(manifest.options_ui?.page, 'options page');
need(manifest.side_panel?.default_path, 'side panel');
need('offscreen/offscreen.html', 'offscreen document');
need('content.js', 'content script injected by scripting.executeScript');
need('vendor/ffmpeg/ffmpeg-core.js', 'bundled FFmpeg core');
need('vendor/ffmpeg/ffmpeg-core.wasm', 'bundled FFmpeg wasm');

// Permissions: nothing broad may be granted at install time.
const hostPerms = [
  ...(manifest.host_permissions ?? []),
  ...(manifest.content_scripts ?? []).flatMap((c) => c.matches ?? []),
];
if (hostPerms.length) fail(`install-time host access must be empty, found ${hostPerms.join(', ')}`);
if (
  (manifest.permissions ?? []).some((p) =>
    ['webRequest', 'webRequestBlocking', 'tabs', 'cookies', 'history'].includes(p),
  )
) {
  fail('manifest.permissions contains a permission that should be optional or unused');
}
const csp = manifest.content_security_policy?.extension_pages ?? '';
if (/(?<!wasm-)unsafe-eval|https?:/.test(csp)) fail(`CSP allows unsafe-eval or remote origins: ${csp}`);
if (!/wasm-unsafe-eval/.test(csp)) fail('CSP must allow wasm-unsafe-eval for FFmpeg.wasm');

// Locales: every __MSG_x__ in the manifest exists; catalogs have identical keys.
const locales = readdirSync(join(dist, '_locales'));
if (!locales.includes(manifest.default_locale)) fail('default_locale catalog missing');
const catalogs = Object.fromEntries(locales.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) {
  for (const [l, c] of Object.entries(catalogs)) if (!c[m[1]]) fail(`locale ${l} lacks ${m[1]}`);
}
const base = Object.keys(catalogs[manifest.default_locale] ?? {})
  .sort()
  .join();
for (const [l, c] of Object.entries(catalogs))
  if (Object.keys(c).sort().join() !== base) fail(`locale ${l} keys differ`);

// HTML pages: only local resources, no inline script (blocked by the extension CSP).
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const file of walk(dist).filter((f) => f.endsWith('.html'))) {
  const rel = file.slice(dist.length + 1);
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=/.test(m[1])) fail(`${rel}: inline <script> would violate CSP`);
  }
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref)) fail(`${rel}: remote resource ${ref}`);
    else if (!ref.startsWith('data:') && !ref.startsWith('#')) {
      const target = resolve(dirname(file), ref.split(/[?#]/)[0]);
      if (!existsSync(target)) fail(`${rel}: references missing ${ref}`);
    }
  }
}

// App code must not fetch or import remote code, or use eval-like constructs (vendor/ is third-party and excluded).
for (const file of walk(dist).filter((f) => f.endsWith('.js') && !f.includes(`${join(dist, 'vendor')}`))) {
  const code = readFileSync(file, 'utf8');
  const rel = file.slice(dist.length + 1);
  if (/\beval\s*\(/.test(code) || /new Function\(/.test(code)) fail(`${rel}: eval/new Function present`);
  if (/importScripts\(\s*["']https?:/.test(code) || /import\(\s*["']https?:/.test(code))
    fail(`${rel}: remote import`);
}

const wasm = statSync(join(dist, 'vendor/ffmpeg/ffmpeg-core.wasm')).size;
console.log(
  `dist OK check: ${walk(dist).length} files, FFmpeg wasm ${(wasm / 1048576).toFixed(1)} MB, version ${manifest.version}`,
);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('manifest, assets, locales and CSP checks passed');
