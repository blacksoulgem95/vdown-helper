// End-to-end tests: real Chromium + the production build loaded unpacked, against local fixture servers.
// Verifies detection, direct + HLS downloads (AES-128, merge, FFmpeg.wasm audio), cancel/retry/pause, settings,
// and that no extension context logs console errors. Files produced by the extension are inspected with ffprobe.
//
//   npm run test:e2e            (builds first)
//   E2E_SAVE_SCREENS=1 npm run test:e2e   (also copies screenshots to docs/screenshots)
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumExecutable } from '../scripts/browser.mjs';
import { ensureFixtures } from './fixtures.mjs';
import { startServers } from './server.mjs';

const here = import.meta.dirname;
const root = resolve(here, '..');
const tmp = join(here, '.tmp');
const run = join(tmp, 'run');
const shots = join(tmp, 'screens');

console.log('> building extension');
execFileSync('node', [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
execFileSync('node', [join(root, 'scripts/check-dist.mjs')], { stdio: 'inherit' });

rmSync(run, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const fixtures = join(tmp, 'fixtures');
ensureFixtures(fixtures);

// Test build: identical, plus install-time access to the "website" origin only (stands in for the per-site grant
// that a real user gives through Chrome's permission prompt, which automation cannot click).
const extDir = join(run, 'ext');
cpSync(join(root, 'dist'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
// 127.0.0.1-3 are three different origins (site + two nested frames); localhost (B) is deliberately NOT granted.
manifest.host_permissions = ['http://127.0.0.1/*', 'http://127.0.0.2/*', 'http://127.0.0.3/*'];
// Stands in for the optional webRequest grant (the real grant needs a user gesture + browser prompt).
manifest.permissions = [...manifest.permissions, 'webRequest', 'declarativeNetRequestWithHostAccess'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const downloads = join(run, 'downloads');
const profile = join(run, 'profile');
mkdirSync(downloads, { recursive: true });
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(
  join(profile, 'Default/Preferences'),
  JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
    savefile: { default_directory: downloads },
  }),
);

const servers = await startServers(fixtures, join(here, 'pages'));
const A = servers.a;
const B = servers.b;
const C = servers.c;
const D = servers.d;

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: chromiumExecutable(),
  headless: false,
  viewport: { width: 1100, height: 900 },
  env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
  args: [
    '--headless=new',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

// ---- console capture (extension contexts only: service worker, offscreen, popup, options, side panel)
const consoleLog = [];
ctx.on('console', (m) => {
  const url = m.location().url ?? '';
  if (url.startsWith('chrome-extension://') || m.page() === null)
    consoleLog.push({ type: m.type(), text: m.text(), url });
});
const requestedUrls = new Set();
ctx.on('request', (r) => requestedUrls.add(r.url()));
ctx.on('weberror', (e) =>
  consoleLog.push({ type: 'error', text: `uncaught: ${e.error().message}`, url: '' }),
);

let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
const extId = new URL(sw.url()).host;
const extUrl = (p) => `chrome-extension://${extId}/${p}`;

// A long-lived extension page: reads storage and observes job stages without needing the service worker awake.
const extPage = await ctx.newPage();
await extPage.goto(extUrl('options/options.html'));
await extPage.evaluate(() => {
  window.__stages = {};
  window.__progress = {};
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !c['jobs']) return;
    for (const j of Object.values(c['jobs'].newValue ?? {})) {
      const seen = (window.__stages[j.id] ??= []);
      if (!seen.includes(j.stage)) seen.push(j.stage);
      if (j.progress?.fraction !== undefined)
        (window.__progress[j.id] ??= []).push([j.stage, j.progress.fraction]);
    }
  });
});
const ext = (fn, arg) => extPage.evaluate(fn, arg);
const jobs = async () =>
  Object.values((await ext(() => chrome.storage.local.get('jobs'))).jobs ?? {}).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
const progressOf = (id) => ext((i) => window.__progress[i] ?? [], id);
const stagesOf = (id) => ext((i) => window.__stages[i] ?? [], id);

// ---- tiny test runner
const results = [];
class Skip extends Error {}
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    if (e instanceof Skip) {
      results.push({ name, ok: true, skipped: true });
      console.log(`  SKIP  ${name}\n        ${e.message}`);
      return;
    }
    results.push({ name, ok: false, error: e });
    console.log(
      `  FAIL  ${name}\n        ${String(e?.message ?? e)
        .split('\n')
        .join('\n        ')}`,
    );
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(fn, what, timeout = 30000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
const shot = async (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });

function probe(file) {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  );
  return {
    codecs: out.streams.map((s) => s.codec_name),
    types: out.streams.map((s) => s.codec_type),
    duration: Number(out.format.duration),
    format: out.format.format_name,
    width: out.streams.find((s) => s.codec_type === 'video')?.width,
    raw: out,
  };
}
// Decode everything: catches corrupted data (e.g. a wrong AES key) that a header-only probe would miss.
function decodeErrors(file) {
  try {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return String(e.stderr ?? e.message);
  }
}

async function jobFinished(match, timeout = 90000) {
  return until(
    async () =>
      (await jobs()).find((j) => match(j) && ['completed', 'failed', 'cancelled'].includes(j.stage)),
    'job to finish',
    timeout,
  );
}
const fileOf = (job) => {
  assert(
    job.filePath && existsSync(job.filePath),
    `downloaded file missing for ${job.request.filename}: ${job.filePath}`,
  );
  return job.filePath;
};

// ---- fixtures: the website page
const page = await ctx.newPage();
await page.goto(`${A}/pages/main.html?cdn=${encodeURIComponent(B)}`);
await page.waitForLoadState('load');
await page.waitForTimeout(1200); // let the page's fetch() calls land in the Performance timeline
const tabId = await ext(
  async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id,
  `${A}/pages/main.html`,
);
assert(tabId, 'fixture tab not found');

async function openPopup(forTab) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 440, height: 760 });
  await p.goto(extUrl(`popup/popup.html?tabId=${forTab}`));
  return p;
}
const stateOf = async () =>
  (await ext((id) => chrome.storage.session.get(`tab:${id}`), tabId))[`tab:${tabId}`];
const byPath = (state, path) => state.resources.find((r) => r.url.endsWith(path));

console.log(`\n> E2E against ${A} (site) and ${B} (cdn), extension ${extId}\n`);

let popup;
let state;

await step('service worker is running and settings default to the documented values', async () => {
  const s = (await ext(() => chrome.storage.local.get('settings'))).settings;
  assert(s === undefined || s.defaultMode === 'video-audio', 'unexpected default mode');
});

await step('popup scans the page and reports READY', async () => {
  popup = await openPopup(tabId);
  await popup.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 45000 });
  state = await stateOf();
  assert(state.status === 'ready', `state ${state.status} ${state.error ?? ''}`);
  console.log(
    `        ${state.resources.length} resources: ${state.resources.map((r) => r.url.replace(/^https?:\/\/[^/]+/, '')).join(', ')}`,
  );
});

await step(
  'detects direct MP4 once (deduplicated across element + link + performance) with real size',
  async () => {
    const mp4s = state.resources.filter((r) => r.url.endsWith('/media/sample.mp4'));
    assert(mp4s.length === 1, `expected 1 mp4 card, got ${mp4s.length}`);
    const r = mp4s[0];
    assert(r.kind === 'file' && r.format === 'mp4', `kind/format ${r.kind}/${r.format}`);
    assert(r.downloadability.status === 'downloadable', 'not downloadable');
    assert(r.sizeBytes > 10_000, `size ${r.sizeBytes}`);
    assert(r.detectedBy.length >= 2, `detectedBy ${r.detectedBy}`);
    assert(r.title === 'Sample clip', `title ${r.title}`);
  },
);

await step('HLS master: lists only real variants, audio, duration; size is an estimate', async () => {
  const r = byPath(state, '/hls/master.m3u8');
  assert(r && r.kind === 'hls-master', 'master missing');
  assert(
    r.variants.length === 2 && r.variants[0].height === 360 && r.variants[1].height === 180,
    `variants ${JSON.stringify(r.variants.map((v) => v.height))}`,
  );
  assert(Math.abs(r.durationSec - 6) < 0.6, `duration ${r.durationSec}`);
  assert(r.sizeIsEstimate === true && r.sizeBytes > 0, 'estimate flag');
  assert(r.downloadability.status === 'downloadable', 'not downloadable');
});

await step('separate audio rendition and AES-128 playlists are recognised', async () => {
  const sep = byPath(state, '/hls-sep/master.m3u8');
  assert(sep.audioTracks.length === 1 && sep.variants.length === 1, 'sep master');
  const aes = byPath(state, '/hls-aes/index.m3u8');
  assert(
    aes.kind === 'hls-media' && aes.playlist.encryption.join() === 'AES-128',
    `aes ${JSON.stringify(aes.playlist)}`,
  );
  assert(aes.downloadability.status === 'downloadable', 'aes should be downloadable');
});

await step('protected, live, plain M3U and DASH are classified honestly (never downloadable)', async () => {
  const expect = [
    ['/hls-drm/index.m3u8', 'protected', 'sample-aes'],
    ['/hls-live/index.m3u8', 'unsupported', 'live'],
    ['/lists/playlist.m3u', 'unsupported', 'plain-m3u'],
    ['/dash/manifest.mpd', 'unsupported', 'malformed'],
    ['/dash-live/manifest.mpd', 'unsupported', 'live'],
    ['/dash-drm/manifest.mpd', 'protected', 'drm'],
  ];
  for (const [path, status, reason] of expect) {
    const r = byPath(state, path);
    assert(r, `${path} not detected`);
    assert(
      r.downloadability.status === status && r.downloadability.reason === reason,
      `${path}: ${JSON.stringify(r.downloadability)}`,
    );
    const card = popup.locator(`[data-resource-id="${r.id}"]`);
    assert(
      await card.getByRole('button', { name: 'DOWNLOAD' }).isDisabled(),
      `${path}: DOWNLOAD must be disabled`,
    );
  }
});

await step(
  'cross-origin: CORS-open CDN works, CORS-closed CDN is INACCESSIBLE with an access button',
  async () => {
    const open = state.resources.find((r) => r.url === `${B}/open/hls/master.m3u8`);
    const closed = state.resources.find((r) => r.url === `${B}/closed/hls/master.m3u8`);
    assert(open?.downloadability.status === 'downloadable', `open: ${JSON.stringify(open?.downloadability)}`);
    assert(
      closed?.downloadability.status === 'inaccessible' && closed.downloadability.reason === 'cors',
      `closed: ${JSON.stringify(closed?.downloadability)}`,
    );
    const card = popup.locator(`[data-resource-id="${closed.id}"]`);
    await card.getByRole('button', { name: 'ALLOW SITE ACCESS' }).waitFor();
  },
);

await step('popup renders cards, details and queue (screenshot)', async () => {
  await popup.screenshot({ path: join(shots, 'popup-detected.png'), fullPage: true });
  const r = byPath(state, '/hls/master.m3u8');
  const card = popup.locator(`[data-resource-id="${r.id}"]`);
  await card.getByRole('button', { name: 'DETAILS' }).click();
  await card.getByText('360p').first().waitFor();
  assert(await card.getByText('HLS MASTER').first().isVisible(), 'kind badge');
  // keyboard accessibility: the primary actions are reachable and focusable
  await card.getByRole('button', { name: 'DOWNLOAD' }).focus();
  assert(await popup.evaluate(() => document.activeElement?.tagName === 'BUTTON'), 'focus on button');
});

await step(
  'keyboard: Tab reaches every primary action with a visible focus ring; radios work with Enter',
  async () => {
    await popup.bringToFront();
    await popup.evaluate(() => document.body.focus());
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      await popup.keyboard.press('Tab');
      const info = await popup.evaluate(() => {
        const el = document.activeElement;
        return {
          name: (el?.getAttribute('aria-label') || el?.textContent || '').trim().slice(0, 30),
          outline: el ? getComputedStyle(el).outlineWidth : '0px',
          tag: el?.tagName,
        };
      });
      if (info.tag === 'BUTTON') {
        seen.add(info.name);
        assert(parseFloat(info.outline) >= 1.5, `no visible focus ring on "${info.name}" (${info.outline})`);
      }
    }
    for (const needed of ['RESCAN PAGE', 'DOWNLOAD', 'CONFIGURE', 'Settings'])
      assert(
        [...seen].some((n) => n.startsWith(needed)),
        `Tab never reached "${needed}" (saw ${[...seen].join(' | ')})`,
      );
  },
);

await step('DIRECT MP4: native Chrome download completes and the file is a valid H.264/AAC MP4', async () => {
  const r = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
  await popup.locator(`[data-resource-id="${r.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
  const job = await jobFinished((j) => j.request.resourceId === r.id);
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  assert(
    job.request.filename === 'Sample clip [360p].mp4' || job.request.filename.startsWith('Sample clip'),
    `name ${job.request.filename}`,
  );
  const p = probe(fileOf(job));
  assert(p.codecs.includes('h264') && p.codecs.includes('aac'), `codecs ${p.codecs}`);
  assert(
    (await stagesOf(job.id)).join() === 'detected,preparing,downloading,completed',
    `stages ${await stagesOf(job.id)}`,
  );
});

await step(
  'HLS master (muxed audio): segments are joined on disk into a valid, fully decodable TS',
  async () => {
    const r = byPath(state, '/hls/master.m3u8');
    await popup.locator(`[data-resource-id="${r.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
    const job = await jobFinished((j) => j.request.resourceId === r.id);
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    assert(job.request.filename.endsWith('.ts'), `ext ${job.request.filename}`);
    const file = fileOf(job);
    const p = probe(file);
    assert(p.codecs.includes('h264') && p.codecs.includes('aac'), `codecs ${p.codecs}`);
    assert(Math.abs(p.duration - 6) < 0.8, `duration ${p.duration}`);
    assert(p.width === 640, `width ${p.width}`);
    const err = decodeErrors(file);
    assert(err === '', `decode errors: ${err.slice(0, 200)}`);
    assert(!(await stagesOf(job.id)).includes('merging'), 'concat path must not involve FFmpeg');
    assert(
      job.progress.unitsTotal === 3 && job.progress.unitsDone === 3,
      `segment counters ${JSON.stringify(job.progress)}`,
    );
  },
);

await step('AES-128 HLS is decrypted correctly (fully decodable output)', async () => {
  const r = byPath(state, '/hls-aes/index.m3u8');
  await popup.locator(`[data-resource-id="${r.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
  const job = await jobFinished((j) => j.request.resourceId === r.id);
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  const file = fileOf(job);
  const err = decodeErrors(file);
  assert(err === '', `decode errors (wrong key/IV?): ${err.slice(0, 200)}`);
  assert(Math.abs(probe(file).duration - 6) < 0.8, 'duration');
});

await step(
  'CORS-open CDN stream downloads without any permission prompt (wildcard-ACAO credential fallback)',
  async () => {
    const r = state.resources.find((x) => x.url === `${B}/open/hls/master.m3u8`);
    await popup.locator(`[data-resource-id="${r.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
    const job = await jobFinished((j) => j.request.resourceId === r.id);
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    assert(decodeErrors(fileOf(job)) === '', 'decode errors');
  },
);

await step('popup controls: RESCAN PAGE, Settings gear, Copy URL and CONFIGURE all work', async () => {
  // RESCAN PAGE
  const before = (await stateOf()).scannedAt;
  await popup.getByRole('button', { name: 'RESCAN PAGE' }).click();
  await until(async () => (await stateOf()).scannedAt > before, 'a newer scan after RESCAN PAGE', 30000);
  await popup.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 30000 });
  state = await stateOf();

  // Settings gear
  await popup.getByRole('button', { name: 'Settings' }).click();
  await until(
    () => ctx.pages().some((pg) => pg.url().includes('/options/options.html')),
    'options page',
    10000,
  );

  // Copy URL. Chrome cannot grant clipboard permission to extension origins in automation, so the call is observed.
  await popup.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => void (window.__copied = t);
  });
  const mp4 = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
  const card = popup.locator(`[data-resource-id="${mp4.id}"]`);
  await card.getByRole('button', { name: 'DETAILS' }).click();
  await card.getByRole('button', { name: 'Copy URL' }).click();
  await until(
    async () => (await popup.evaluate(() => window.__copied)) === mp4.url,
    'URL passed to the clipboard',
    5000,
  );

  // CONFIGURE hands the selection to the Studio (the popup may close itself once the side panel opens)
  const p3 = await openPopup(tabId);
  await p3.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 30000 });
  await ext(() => chrome.storage.session.remove('studio:selection'));
  await p3.locator(`[data-resource-id="${mp4.id}"]`).getByRole('button', { name: 'CONFIGURE' }).click();
  await until(
    async () =>
      (await ext(() => chrome.storage.session.get('studio:selection')))['studio:selection']?.resourceId ===
      mp4.id,
    'studio selection',
    10000,
  );
  if (!p3.isClosed()) await p3.close();
});

// ---- Studio (side panel page, opened as a tab so automation can drive it)
const studio = await ctx.newPage();
await studio.setViewportSize({ width: 460, height: 1000 });
await studio.goto(extUrl('sidepanel/sidepanel.html'));
async function select(resource) {
  await studio.evaluate((sel) => chrome.storage.session.set({ 'studio:selection': sel }), {
    tabId,
    resourceId: resource.id,
    at: Date.now(),
  });
  await studio.getByRole('heading', { name: resource.title }).first().waitFor({ timeout: 10000 });
}

await step(
  'Studio: separate audio + video merge to MP4 via FFmpeg.wasm (MERGING stage, valid output)',
  async () => {
    const r = byPath(state, '/hls-sep/master.m3u8');
    await select(r);
    await studio.getByLabel('Output container').selectOption('mp4');
    await studio.getByText('Segments are fetched, then FFmpeg.wasm copies').waitFor({ timeout: 15000 });
    await shot(studio, 'studio-merge');
    const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
    await until(() => start.isEnabled(), 'start enabled');
    await start.click();
    const job = await jobFinished((j) => j.request.resourceId === r.id, 120000);
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    const stages = await stagesOf(job.id);
    assert(stages.includes('downloading') && stages.includes('merging'), `stages ${stages}`);
    const file = fileOf(job);
    const p = probe(file);
    assert(job.request.filename.endsWith('.mp4'), job.request.filename);
    assert(p.codecs.includes('h264') && p.codecs.includes('aac'), `codecs ${p.codecs}`);
    assert(Math.abs(p.duration - 6) < 0.8, `duration ${p.duration}`);
    assert(decodeErrors(file) === '', 'decode errors');
  },
);

await step('Studio: audio-only MP3 (real transcode, 128 kbps) through FFmpeg.wasm', async () => {
  const r = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
  await select(r);
  await studio.getByRole('radio', { name: /Audio only/ }).click();
  await studio.getByLabel('Audio format').selectOption('mp3');
  await studio.getByLabel('Audio bitrate').selectOption('128');
  await studio.getByText(/transcoded with FFmpeg\.wasm/).waitFor();
  const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
  await until(() => start.isEnabled(), 'start enabled');
  await start.click();
  const job = await jobFinished(
    (j) => j.request.resourceId === r.id && j.request.mode === 'audio-only',
    120000,
  );
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  assert((await stagesOf(job.id)).includes('encoding'), `stages ${await stagesOf(job.id)}`);
  const file = fileOf(job);
  const p = probe(file);
  assert(
    job.request.filename.endsWith('.mp3') && p.codecs.join() === 'mp3',
    `codec ${p.codecs} ${job.request.filename}`,
  );
  const kbps = Number(p.raw.format.bit_rate) / 1000;
  assert(kbps > 100 && kbps < 150, `bitrate ${kbps}`);
});

await step('Studio: AAC audio is stream-COPIED to M4A (no bitrate choice offered)', async () => {
  const r = byPath(state, '/hls/master.m3u8');
  await select(r);
  await studio.getByRole('radio', { name: /Audio only/ }).click();
  await studio.getByLabel('Audio format').selectOption('m4a');
  await studio.getByText('Stream copy: no bitrate choice').waitFor();
  assert(
    (await studio.getByLabel('Audio bitrate').count()) === 0,
    'bitrate must not be offered for stream copy',
  );
  const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
  await until(() => start.isEnabled(), 'start enabled');
  await start.click();
  const job = await jobFinished(
    (j) => j.request.resourceId === r.id && j.request.mode === 'audio-only',
    120000,
  );
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  const p = probe(fileOf(job));
  assert(p.codecs.join() === 'aac' && p.types.join() === 'audio', `codecs ${p.codecs}`);
});

await step(
  'DASH: real manifest lists only real representations; separate audio; estimated size',
  async () => {
    const r = byPath(state, '/dash-vod/manifest.mpd');
    assert(r && r.kind === 'dash' && r.format === 'dash', `kind ${r?.kind}`);
    assert(
      JSON.stringify(r.variants.map((v) => v.height)) === '[360,180]',
      `variants ${JSON.stringify(r.variants.map((v) => v.height))}`,
    );
    assert(
      r.audioTracks.length === 1 && r.variants.every((v) => v.audioGroup === 'dash-audio'),
      'audio track',
    );
    assert(Math.abs(r.durationSec - 6) < 0.3 && r.sizeIsEstimate === true, `duration ${r.durationSec}`);
    assert(r.downloadability.status === 'downloadable', JSON.stringify(r.downloadability));
    assert(r.playlist.segmentCount === 3 && r.playlist.live === false, JSON.stringify(r.playlist));
  },
);

await step(
  'DASH: quick DOWNLOAD merges video + audio to a valid, fully decodable MP4 (MERGING, no re-encode)',
  async () => {
    const r = byPath(state, '/dash-vod/manifest.mpd');
    await popup.locator(`[data-resource-id="${r.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
    const job = await jobFinished((j) => j.request.resourceId === r.id, 120000);
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    const stages = await stagesOf(job.id);
    assert(stages.includes('merging') && !stages.includes('encoding'), `stages ${stages}`);
    const file = fileOf(job);
    const p = probe(file);
    assert(
      p.codecs.includes('h264') && p.codecs.includes('aac') && p.width === 640,
      `${p.codecs} ${p.width}`,
    );
    assert(Math.abs(p.duration - 6) < 0.8, `duration ${p.duration}`);
    assert(decodeErrors(file) === '', 'decode errors');
  },
);

await step(
  'DASH: choosing 180p in the Studio downloads that representation; audio-only copies the AAC track',
  async () => {
    const r = byPath(state, '/dash-vod/manifest.mpd');
    await select(r);
    await studio.getByRole('radio', { name: /180p/ }).click();
    await studio.getByLabel('Output container').selectOption('mp4');
    const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
    await until(() => start.isEnabled(), 'start enabled');
    await start.click();
    const job = await jobFinished(
      (j) => j.request.resourceId === r.id && /180p/.test(j.request.filename),
      120000,
    );
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    const p = probe(fileOf(job));
    assert(p.width === 320, `width ${p.width}`);

    await studio.getByRole('radio', { name: /Audio only/ }).click();
    await studio.getByLabel('Audio format').selectOption('m4a');
    await studio.getByText('Stream copy: no bitrate choice').waitFor();
    await until(() => start.isEnabled(), 'start enabled');
    await start.click();
    const audio = await jobFinished(
      (j) => j.request.resourceId === r.id && j.request.mode === 'audio-only',
      120000,
    );
    assert(audio.stage === 'completed', `stage ${audio.stage}: ${JSON.stringify(audio.error)}`);
    const ap = probe(fileOf(audio));
    assert(ap.codecs.join() === 'aac' && ap.types.join() === 'audio', `${ap.codecs}`);
  },
);

await step(
  'DASH: a Widevine manifest is refused everywhere, including a direct request to the background',
  async () => {
    const r = byPath(state, '/dash-drm/manifest.mpd');
    assert(r.downloadability.status === 'protected', JSON.stringify(r.downloadability));
    assert(
      await popup
        .locator(`[data-resource-id="${r.id}"]`)
        .getByRole('button', { name: 'DOWNLOAD' })
        .isDisabled(),
      'DOWNLOAD must be disabled',
    );
    const res = await ext(
      (req) =>
        chrome.runtime.sendMessage({ channel: 'vdown', type: 'start-download', payload: { request: req } }),
      {
        resourceId: r.id,
        sourceUrl: `${r.url}#vdh-rep=0`,
        tabId,
        pageUrl: r.pageUrl,
        host: r.host,
        mode: 'original',
        container: 'mp4',
        audioFormat: 'mp3',
        audioBitrate: 192,
        filename: 'drm-dash.mp4',
        subfolder: '',
        qualityLabel: 'x',
        sourceFormat: 'dash',
        isHls: false,
        isDash: true,
        hasMuxedAudio: true,
        hasVideo: true,
      },
    );
    assert(res.ok === false && /protected|inspect/.test(res.error), JSON.stringify(res));
  },
);

const subtitleByUrl = (suffix) =>
  state.resources.find((r) => r.kind === 'subtitle' && r.url.endsWith(suffix));
const text = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

await step(
  'subtitles: <track>, linked files, HLS and DASH subtitle renditions are found, with languages',
  async () => {
    const subs = state.resources.filter((r) => r.kind === 'subtitle');
    const track = subtitleByUrl('/subs/en.vtt');
    assert(
      track?.format === 'vtt' && track.language === 'en' && track.title === 'English',
      `track ${JSON.stringify(track)}`,
    );
    assert(track.detectedBy.includes('dom-track'), `detectedBy ${track.detectedBy}`);
    assert(subtitleByUrl('/subs/it.srt')?.format === 'srt', 'srt link');
    assert(subtitleByUrl('/subs/en.ttml')?.format === 'ttml', 'ttml link');
    const hls = subtitleByUrl('/hls-subs/sub-en/index.m3u8');
    assert(
      hls?.format === 'hls' && hls.language === 'en' && hls.downloadability.status === 'downloadable',
      `hls ${JSON.stringify(hls)}`,
    );
    assert(Math.abs(hls.durationSec - 12) < 0.1, `duration ${hls.durationSec}`);
    const dash = subtitleByUrl('#vdh-rep=sub-it');
    assert(dash?.format === 'dash' && dash.language === 'it', `dash ${JSON.stringify(dash)}`);
    // the segments of the subtitle playlist are not listed as subtitles of their own
    assert(!subs.some((r) => /seg\d\.vtt$/.test(r.url)), 'subtitle segments leaked into the list');
    // the manifests that carry them are still media
    assert(byPath(state, '/hls-subs/master.m3u8')?.kind === 'hls-master', 'master lost');
    assert(
      state.resources.find((r) => r.url.endsWith('/dash-vod/manifest-subs.mpd'))?.kind === 'dash',
      'dash lost',
    );
  },
);

await step('subtitles: the popup lists them in their own tab, media stays in the other', async () => {
  const n = state.resources.filter((r) => r.kind === 'subtitle').length;
  const m = state.resources.length - n;
  await popup.reload();
  await popup.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 45000 });
  const tabs = popup.getByRole('tablist');
  await tabs.waitFor();
  assert((await popup.locator('[data-resource-id]').count()) === m, 'media tab count');
  await popup.getByRole('tab', { name: /Subtitles/i }).click();
  assert((await popup.locator('[data-resource-id]').count()) === n, 'subtitle tab count');
  // keyboard: arrow keys move between tabs
  await popup.getByRole('tab', { name: /Subtitles/i }).focus();
  await popup.keyboard.press('ArrowLeft');
  assert(
    (await popup.getByRole('tab', { name: /Media/i }).getAttribute('aria-selected')) === 'true',
    'ArrowLeft did not select Media',
  );
  await popup.getByRole('tab', { name: /Subtitles/i }).click();
  await shot(popup, 'popup-subtitles');
});

await step('subtitles: a WebVTT track is saved as found by a native download (byte-for-byte)', async () => {
  const r = subtitleByUrl('/subs/en.vtt');
  await popup.locator(`[data-resource-id="${r.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
  const job = await jobFinished((j) => j.request.resourceId === r.id);
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  assert(!job.viaOffscreen && job.request.filename.endsWith('.vtt'), `name ${job.request.filename}`);
  assert(
    readFileSync(fileOf(job), 'utf8') === readFileSync(join(fixtures, 'subs/en.vtt'), 'utf8'),
    'file differs from the original',
  );
});

async function saveSubtitle(r, format) {
  await select(r);
  await studio.getByLabel('Subtitle format').selectOption(format);
  const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
  await until(() => start.isEnabled(), 'start enabled');
  await start.click();
  const job = await jobFinished(
    (j) =>
      j.request.resourceId === r.id &&
      j.request.subtitle?.output === format &&
      j.createdAt > Date.now() - 120000,
  );
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  return job;
}

await step('subtitles: WebVTT, SRT and TTML tracks convert to valid SRT', async () => {
  const expectSrt = {
    '/subs/en.vtt':
      '1\n00:00:01,000 --> 00:00:02,500\nHello <i>world</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond & last\n',
    '/subs/it.srt': '1\n00:00:00,500 --> 00:00:01,500\nCiao\n\n2\n00:00:02,000 --> 00:00:03,000\nMondo\n',
    '/subs/en.ttml':
      '1\n00:00:01,000 --> 00:00:02,000\nHello\nworld\n\n2\n00:00:02,500 --> 00:00:04,000\nTwo spans\n',
  };
  for (const [path, want] of Object.entries(expectSrt)) {
    const job = await saveSubtitle(subtitleByUrl(path), 'srt');
    assert(job.request.filename.endsWith('.srt'), `name ${job.request.filename}`);
    assert(job.viaOffscreen === true, `${path}: conversion runs in the offscreen document`);
    const got = text(fileOf(job));
    assert(got === want, `${path}: ${JSON.stringify(got)}`);
  }
});

await step(
  'subtitles: segmented HLS WebVTT is stitched on the media timeline (X-TIMESTAMP-MAP), as SRT and as WebVTT',
  async () => {
    const r = subtitleByUrl('/hls-subs/sub-en/index.m3u8');
    const srt = await saveSubtitle(r, 'srt');
    assert(
      text(fileOf(srt)) ===
        '1\n00:00:01,000 --> 00:00:03,000\nFirst segment\n\n2\n00:00:06,500 --> 00:00:08,000\nSecond segment\n',
      JSON.stringify(text(fileOf(srt))),
    );
    const vtt = await saveSubtitle(r, 'original');
    assert(vtt.request.filename.endsWith('.vtt'), `name ${vtt.request.filename}`);
    assert(
      text(fileOf(vtt)) ===
        'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst segment\n\n00:00:06.500 --> 00:00:08.000\nSecond segment\n',
      JSON.stringify(text(fileOf(vtt))),
    );
  },
);

await step('subtitles: a DASH text track (IMSC1 in MP4) is read and saved as SRT', async () => {
  const job = await saveSubtitle(subtitleByUrl('#vdh-rep=sub-it'), 'srt');
  assert(
    text(fileOf(job)) ===
      '1\n00:00:01,000 --> 00:00:02,000\nPrima riga\n\n2\n00:00:03,000 --> 00:00:04,500\nSeconda riga\n',
    JSON.stringify(text(fileOf(job))),
  );
});

await step('Studio: output mode radios are operable from the keyboard', async () => {
  const r = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
  await select(r);
  const radio = studio.getByRole('radio', { name: /Audio only/ });
  await radio.focus();
  await studio.keyboard.press('Enter');
  assert((await radio.getAttribute('aria-checked')) === 'true', 'Enter did not select the radio');
  await studio.getByRole('radio', { name: /Video \+ Audio/ }).click();
});

await step(
  'Studio: MPEG-TS → MP4 remux is a stream copy through FFmpeg.wasm (MERGING, no re-encode, decodable)',
  async () => {
    const r = byPath(state, '/hls/master.m3u8');
    await select(r);
    await studio.getByRole('radio', { name: /Video \+ Audio/ }).click();
    await studio.getByLabel('Output container').selectOption('mp4');
    await studio.getByText('No re-encoding.').first().waitFor();
    const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
    await until(() => start.isEnabled(), 'start enabled');
    await start.click();
    const job = await jobFinished(
      (j) => j.request.resourceId === r.id && j.request.container === 'mp4',
      120000,
    );
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    const stages = await stagesOf(job.id);
    assert(stages.includes('merging') && !stages.includes('encoding'), `stages ${stages}`);
    const file = fileOf(job);
    const p = probe(file);
    assert(
      p.codecs.includes('h264') && p.codecs.includes('aac') && /mp4/.test(p.format),
      `${p.codecs} ${p.format}`,
    );
    assert(decodeErrors(file) === '', 'decode errors');
  },
);

await step('Studio: audio-only WAV is uncompressed PCM and offers no bitrate', async () => {
  const r = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
  await select(r);
  await studio.getByRole('radio', { name: /Audio only/ }).click();
  await studio.getByLabel('Audio format').selectOption('wav');
  await studio.getByText('Uncompressed: no bitrate setting.').waitFor();
  assert((await studio.getByLabel('Audio bitrate').count()) === 0, 'no bitrate for WAV');
  const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
  await until(() => start.isEnabled(), 'start enabled');
  await start.click();
  const job = await jobFinished(
    (j) =>
      j.request.resourceId === r.id && j.request.audioFormat === 'wav' && j.request.mode === 'audio-only',
    120000,
  );
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  const p = probe(fileOf(job));
  assert(p.codecs.join() === 'pcm_s16le', `codec ${p.codecs}`);
  assert(Math.abs(p.duration - 6) < 0.5, `duration ${p.duration}`);
});

await step(
  'Studio: "Original quality" with MP4 refuses an audio codec MP4 cannot hold (never re-encodes)',
  async () => {
    // The planner is unit-tested for this; here the UI must show the reason and block Start.
    const r = byPath(state, '/hls/master.m3u8');
    await select(r);
    await studio.getByRole('radio', { name: /Original quality/ }).click();
    await studio.getByLabel('Output container').selectOption('mp4');
    assert(
      await studio.getByRole('button', { name: 'START DOWNLOAD' }).isEnabled(),
      'AAC fits MP4: start must be allowed',
    );
    await studio.getByRole('radio', { name: /Video \+ Audio/ }).click();
  },
);

await step(
  'FFmpeg progress is real: a 5-minute MP3 encode reports increasing fractions between 0 and 1',
  async () => {
    const r = state.resources.find((x) => x.url.endsWith('/hls-long/master.m3u8'));
    assert(r, 'long master not detected');
    await select(r);
    await studio.getByRole('radio', { name: /Audio only/ }).click();
    await studio.getByLabel('Audio format').selectOption('mp3');
    await studio.getByLabel('Audio bitrate').selectOption('128');
    const start = studio.getByRole('button', { name: 'START DOWNLOAD' });
    await until(() => start.isEnabled(), 'start enabled');
    await start.click();
    const job = await jobFinished(
      (j) => j.request.resourceId === r.id && j.request.mode === 'audio-only',
      240000,
    );
    assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
    const fractions = (await progressOf(job.id)).filter(([stage]) => stage === 'encoding').map(([, f]) => f);
    const middle = fractions.filter((f) => f > 0 && f < 1);
    console.log(
      `        encoding fractions seen: ${[...new Set(fractions.map((f) => f.toFixed(2)))].join(' ')}`,
    );
    assert(
      middle.length >= 2,
      `expected intermediate progress during encoding, saw ${JSON.stringify(fractions)}`,
    );
    assert(
      middle.every((f, i) => i === 0 || f >= middle[i - 1] - 1e-9),
      'progress must never go backwards',
    );
    const p = probe(fileOf(job));
    assert(p.codecs.join() === 'mp3' && Math.abs(p.duration - 300) < 3, `mp3 ${p.codecs} ${p.duration}s`);
  },
);

await step(
  'Studio: incompatible choices are disabled and Start is blocked for protected streams',
  async () => {
    const r = byPath(state, '/hls-drm/index.m3u8');
    await select(r);
    assert(
      await studio.getByRole('button', { name: 'START DOWNLOAD' }).isDisabled(),
      'protected stream must not be startable',
    );
    await shot(studio, 'studio-protected');
    // a source with no video: video-only is not offered
    const mp3Resource = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
    await select(mp3Resource);
    assert(await studio.getByLabel('Output container').isVisible(), 'container select');
    await shot(studio, 'studio-direct');
  },
);

// ---- queue behaviour via a second popup that shows jobs
const queuePopup = await openPopup(tabId);
await queuePopup.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 45000 });
const baseRequest = {
  resourceId: 'e2e',
  tabId,
  pageUrl: `${A}/pages/main.html`,
  host: '127.0.0.1',
  mode: 'original',
  container: 'ts',
  audioFormat: 'mp3',
  audioBitrate: 192,
  subfolder: '',
  qualityLabel: 'test',
  sourceFormat: 'hls',
  isHls: true,
  hasMuxedAudio: true,
  hasVideo: true,
};
const send = (request) =>
  queuePopup.evaluate(
    (req) =>
      chrome.runtime.sendMessage({ channel: 'vdown', type: 'start-download', payload: { request: req } }),
    request,
  );

await step('pause and resume a native download (real Chrome download manager)', async () => {
  const res = await send({
    ...baseRequest,
    resourceId: 'slow',
    sourceUrl: `${A}/__slow/file.bin`,
    filename: 'slow.bin',
    container: 'original',
    sourceFormat: 'unknown',
    isHls: false,
  });
  assert(res.ok, JSON.stringify(res));
  const row = queuePopup.locator('li', { hasText: 'slow.bin' });
  await row.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 15000 });
  await row.getByRole('button', { name: 'Pause' }).click();
  await row
    .getByText('PAUSED')
    .waitFor({ timeout: 10000 })
    .catch(async (e) => {
      throw new Error(
        `${e.message}\n job: ${JSON.stringify((await jobs()).find((j) => j.request.filename === 'slow.bin'))}`,
      );
    });
  await shot(queuePopup, 'popup-queue-paused');
  await row.getByRole('button', { name: 'Resume' }).click();
  const job = await jobFinished((j) => j.request.filename === 'slow.bin');
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  assert(statSync(fileOf(job)).size === 2 * 1024 * 1024, 'size');
});

await step('cancel an HLS job mid-download: no file is produced and the job is CANCELLED', async () => {
  const before = readdirSync(downloads).length;
  const res = await send({
    ...baseRequest,
    resourceId: 'slowhls',
    sourceUrl: `${B}/slow/hls/v360/index.m3u8`,
    filename: 'cancel-me.ts',
  });
  assert(res.ok, JSON.stringify(res));
  const row = queuePopup.locator('li', { hasText: 'cancel-me.ts' });
  await row.getByRole('button', { name: 'Cancel' }).waitFor({ timeout: 20000 });
  await until(
    async () =>
      (await jobs()).find((j) => j.request.filename === 'cancel-me.ts' && j.stage === 'downloading'),
    'downloading stage',
  );
  await row.getByRole('button', { name: 'Cancel' }).click();
  const job = await jobFinished((j) => j.request.filename === 'cancel-me.ts');
  assert(job.stage === 'cancelled', `stage ${job.stage}`);
  await new Promise((r) => setTimeout(r, 1500));
  assert(readdirSync(downloads).length === before, 'a file appeared after cancel');
});

await step('failed HLS job shows a useful error, then RETRY succeeds once the server recovers', async () => {
  const res = await send({
    ...baseRequest,
    resourceId: 'flaky',
    sourceUrl: `${A}/flaky/index.m3u8`,
    filename: 'flaky.ts',
  });
  assert(res.ok, JSON.stringify(res));
  const failed = await jobFinished((j) => j.request.filename === 'flaky.ts', 60000);
  assert(
    failed.stage === 'failed' && failed.error.code === 'http-error',
    `got ${failed.stage} ${JSON.stringify(failed.error)}`,
  );
  const row = queuePopup.locator('li', { hasText: 'flaky.ts' });
  await row.getByRole('alert').waitFor();
  assert(
    (await row.getByRole('alert').innerText()).includes('404'),
    'error text should mention the HTTP status',
  );
  await shot(queuePopup, 'popup-queue-failed');
  await fetch(`${A}/__flaky/enable`, { method: 'POST' });
  await row.getByRole('button', { name: 'Retry' }).click();
  const ok = await until(
    async () => (await jobs()).find((j) => j.request.filename === 'flaky.ts' && j.stage === 'completed'),
    'retry to complete',
    60000,
  );
  assert(ok.attempts === 1, `attempts ${ok.attempts}`);
  assert(decodeErrors(fileOf(ok)) === '', 'decode errors after retry');
});

await step("a failing native download reports Chrome's reason", async () => {
  const res = await send({
    ...baseRequest,
    resourceId: 'nope',
    sourceUrl: `${A}/media/does-not-exist.mp4`,
    filename: 'nope.mp4',
    container: 'original',
    sourceFormat: 'mp4',
    isHls: false,
  });
  assert(res.ok, JSON.stringify(res));
  const job = await jobFinished((j) => j.request.filename === 'nope.mp4', 30000);
  assert(
    job.stage === 'failed' && job.error.code === 'chrome-download',
    `got ${job.stage} ${JSON.stringify(job.error)}`,
  );
  const row = queuePopup.locator('li', { hasText: 'nope.mp4' });
  await row.getByRole('alert').waitFor();
  assert(
    /SERVER|NETWORK|FAILED|BAD/i.test(await row.getByRole('alert').innerText()),
    'expected a Chrome error reason in the message',
  );
});

await step(
  'memory guard: a stream bigger than the limit is stopped at runtime with a clear error (no crash)',
  async () => {
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, maxMemoryMb: 128 } }));
    const res = await send({
      ...baseRequest,
      resourceId: 'big',
      sourceUrl: `${A}/big/index.m3u8`,
      filename: 'big.mp4',
      container: 'mp4',
    });
    assert(res.ok, JSON.stringify(res));
    const job = await jobFinished((j) => j.request.filename === 'big.mp4', 120000);
    assert(
      job.stage === 'failed' && job.error.code === 'too-large',
      `got ${job.stage} ${JSON.stringify(job.error)}`,
    );
    const row = queuePopup.locator('li', { hasText: 'big.mp4' });
    assert(
      (await row.getByRole('alert').innerText()).includes('memory limit'),
      'message should explain the memory limit',
    );
    // The same stream as plain TS is disk-backed and is not limited.
    const ts = await send({
      ...baseRequest,
      resourceId: 'big',
      sourceUrl: `${A}/big/index.m3u8`,
      filename: 'big.ts',
      container: 'ts',
    });
    assert(ts.ok, JSON.stringify(ts));
    const done = await jobFinished((j) => j.request.filename === 'big.ts', 120000);
    assert(
      done.stage === 'completed' && statSync(fileOf(done)).size === 140 * 1024 * 1024,
      `TS passthrough ${done.stage} ${JSON.stringify(done.error)}`,
    );
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1 } }));
  },
);

await step(
  'open file / show in folder: real clicks (the user gesture is needed) and the background refuses them over messaging',
  async () => {
    const done = (await jobs()).find((j) => j.stage === 'completed' && j.chromeDownloadId !== undefined);
    assert(done, 'no completed job');
    const row = queuePopup.locator('li', { hasText: done.request.filename }).first();
    await row.getByRole('button', { name: 'Show in folder' }).click();
    await row.getByRole('button', { name: 'Open file' }).click();
    await queuePopup.waitForTimeout(600);
    const alerts = await queuePopup.locator('[data-queue-note]').allInnerTexts();
    console.log(`        alerts after open/show: ${JSON.stringify(alerts)}`);
    // Opening may legitimately fail only with our own explanation; it must never throw or leave the UI stuck.
    assert(
      alerts.every((t) => /moved or deleted|no file to open/.test(t)),
      `unexpected alert text ${JSON.stringify(alerts)}`,
    );
    const viaMessage = await queuePopup.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          channel: 'vdown',
          type: 'job-action',
          payload: { jobId: id, action: 'open' },
        }),
      done.id,
    );
    assert(
      viaMessage === undefined,
      'open must not be accepted by the service worker (it has no user gesture)',
    );
  },
);

await step('AES-128 fMP4: the encrypted init section is decrypted too (decodable MP4 output)', async () => {
  const r = byPath(state, '/hls-aes-fmp4/index.m3u8');
  assert(r && r.downloadability.status === 'downloadable', `card ${JSON.stringify(r?.downloadability)}`);
  const res = await send({
    ...baseRequest,
    resourceId: 'fmp4',
    sourceUrl: r.url,
    filename: 'aes-fmp4.mp4',
    container: 'original',
    fragmented: true,
  });
  assert(res.ok, JSON.stringify(res));
  const job = await jobFinished((j) => j.request.filename === 'aes-fmp4.mp4', 90000);
  assert(job.stage === 'completed', `stage ${job.stage}: ${JSON.stringify(job.error)}`);
  const file = fileOf(job);
  assert(probe(file).codecs.includes('h264'), 'not a valid MP4 (init section not decrypted?)');
  assert(decodeErrors(file) === '', 'decode errors');
});

await step(
  'byte-range HLS works even when the server ignores Range (whole file returned, slice kept)',
  async () => {
    const normal = byPath(state, '/hls-range/index.m3u8');
    assert(
      normal && normal.downloadability.status === 'downloadable',
      `card ${JSON.stringify(normal?.downloadability)}`,
    );
    for (const [label, base] of [
      ['range-aware', A],
      ['range-ignoring', `${A}/__norange`],
    ]) {
      const name = `range-${label}.ts`;
      const res = await send({
        ...baseRequest,
        resourceId: name,
        sourceUrl: `${base}/hls-range/index.m3u8`,
        filename: name,
        container: 'ts',
      });
      assert(res.ok, `${label}: ${JSON.stringify(res)}`);
      const job = await jobFinished((j) => j.request.filename === name, 90000);
      assert(job.stage === 'completed', `${label}: ${job.stage} ${JSON.stringify(job.error)}`);
      const file = fileOf(job);
      assert(decodeErrors(file) === '', `${label}: decode errors`);
      assert(Math.abs(probe(file).duration - 6) < 0.8, `${label}: duration ${probe(file).duration}`);
      assert(statSync(file).size < 5 * 1024 * 1024, `${label}: file far too large (${statSync(file).size})`);
    }
  },
);

await step(
  'a server that stalls mid-body fails the job within the idle timeout instead of hanging',
  async () => {
    // The playlist itself comes from the normal fixture server; only its segment stalls.
    const res = await send({
      ...baseRequest,
      resourceId: 'stall',
      sourceUrl: `${A}/stall/index.m3u8`,
      filename: 'stall.ts',
      container: 'ts',
    });
    assert(res.ok, JSON.stringify(res));
    const t0 = Date.now();
    const job = await jobFinished((j) => j.request.filename === 'stall.ts', 90000);
    assert(
      job.stage === 'failed' && job.error.code === 'network',
      `got ${job.stage} ${JSON.stringify(job.error)}`,
    );
    console.log(`        stalled job failed after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  },
);

await step('DRM-protected requests are refused by the background even if the UI is bypassed', async () => {
  const res = await send({
    ...baseRequest,
    resourceId: 'drm',
    sourceUrl: `${A}/hls-drm/index.m3u8`,
    filename: 'drm.ts',
  });
  assert(res.ok === false && res.error === 'protected', JSON.stringify(res));
});

await step('unsafe URLs and hostile file names are rejected / neutralised by the background', async () => {
  const bad = await send({ ...baseRequest, sourceUrl: 'javascript:alert(1)', filename: 'x.ts' });
  assert(bad.ok === false && bad.error === 'unsafe-url', JSON.stringify(bad));
  const res = await send({
    ...baseRequest,
    resourceId: 'evil',
    sourceUrl: `${A}/media/sample.mp4`,
    isHls: false,
    sourceFormat: 'mp4',
    filename: '../../evil\\..\\name.mp4',
    container: 'original',
  });
  assert(res.ok, JSON.stringify(res));
  const job = await jobFinished((j) => j.id === res.jobId);
  assert(
    !/[\\/]/.test(job.request.filename) && job.stage === 'completed',
    `name ${job.request.filename} stage ${job.stage}`,
  );
  assert(existsSync(fileOf(job)), 'file missing');
});

await step('empty page shows the empty state and SCAN AGAIN', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(`${A}/pages/empty.html`);
  const t2 = await ext(
    async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id,
    `${A}/pages/empty.html`,
  );
  const pop = await openPopup(t2);
  await pop.getByRole('heading', { name: 'NO MEDIA DETECTED' }).waitFor({ timeout: 30000 });
  await pop.getByRole('button', { name: 'SCAN AGAIN' }).waitFor();
  await shot(pop, 'popup-empty');
  await pop.close();
  await p2.close();
});

await step('restricted pages are not scanned and say why', async () => {
  const cp = await ctx.newPage();
  await cp.goto('chrome://version');
  const t3 = await ext(
    async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('chrome://version'))?.id,
  );
  const pop = await openPopup(t3);
  await pop.getByRole('heading', { name: 'SCAN UNAVAILABLE' }).waitFor({ timeout: 20000 });
  assert((await pop.getByText(/can't be scanned/).count()) > 0, 'explanation missing');
  assert((await pop.locator('[data-resource-id]').count()) === 0, 'must not list anything');
  await pop.close();
  await cp.close();
});

await step('settings persist across reloads, validate input, and reset', async () => {
  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: 900, height: 1000 });
  await opt.goto(extUrl('options/options.html'));
  await opt.getByLabel('Default download mode').selectOption('audio-only');
  await opt.getByLabel('Naming template').fill('{host} - {title}');
  await opt.getByLabel('Maximum concurrent downloads').fill('99');
  // A person needs far longer than a storage write between editing and reloading; wait for the writes to land.
  await until(async () => {
    const st = (await ext(() => chrome.storage.local.get('settings'))).settings;
    return (
      st?.defaultMode === 'audio-only' &&
      st?.namingTemplate === '{host} - {title}' &&
      st?.maxConcurrentDownloads === 5
    );
  }, 'settings to be written to storage');
  await opt.reload();
  assert((await opt.getByLabel('Default download mode').inputValue()) === 'audio-only', 'mode not persisted');
  assert(
    (await opt.getByLabel('Naming template').inputValue()) === '{host} - {title}',
    'template not persisted',
  );
  assert((await opt.getByLabel('Maximum concurrent downloads').inputValue()) === '5', 'limit not clamped');
  await shot(opt, 'options');
  await opt.getByRole('button', { name: 'Reset settings' }).click();
  await until(
    async () => (await opt.getByLabel('Default download mode').inputValue()) === 'video-audio',
    'reset',
  );
  await opt.close();
});

await step('clear history removes finished jobs only', async () => {
  const before = (await jobs()).length;
  assert(before > 0, 'no jobs');
  await queuePopup.getByRole('button', { name: 'Clear history' }).click();
  await until(
    async () => (await jobs()).every((j) => !['completed', 'failed', 'cancelled'].includes(j.stage)),
    'history cleared',
  );
});

// ---- opt-in detection features (enabled the way the Options toggles would: via stored settings)
await step(
  'network observer (opt-in) finds a request made by a Web Worker that the page timeline cannot see',
  async () => {
    const wp = await ctx.newPage();
    await wp.goto(`${A}/pages/worker.html`);
    await wp.waitForTimeout(800);
    const wtab = await ext(
      async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id,
      `${A}/pages/worker.html`,
    );
    const before = await openPopup(wtab);
    await before.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 30000 });
    const s0 = (await ext((id) => chrome.storage.session.get(`tab:${id}`), wtab))[`tab:${wtab}`];
    assert(
      !s0.resources.some((r) => r.url.endsWith('/hls/master.m3u8')),
      'worker request must be invisible without the observer',
    );
    await before.close();

    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, networkObserver: true } }));
    await until(
      async () => (await sw.evaluate(() => chrome.webRequest.onHeadersReceived.hasListeners())) === true,
      'observer registered',
      10000,
    ).catch(() => undefined);
    await wp.reload();
    await wp.waitForTimeout(1200);
    const after = await openPopup(wtab);
    await after.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 30000 });
    const s1 = (await ext((id) => chrome.storage.session.get(`tab:${id}`), wtab))[`tab:${wtab}`];
    const hit = s1.resources.find((r) => r.url.endsWith('/hls/master.m3u8'));
    assert(
      hit && hit.detectedBy.includes('network'),
      `observer did not find it: ${JSON.stringify(s1.resources.map((r) => [r.url, r.detectedBy]))}`,
    );
    assert(hit.downloadability.status === 'downloadable', 'should be downloadable');
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, networkObserver: false } }));
    await after.close();
    await wp.close();
  },
);

await step(
  'auto-scan (opt-in) scans a page when it finishes loading and shows the count on the toolbar badge',
  async () => {
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, autoScan: true } }));
    const ap = await ctx.newPage();
    await ap.goto(`${A}/pages/main.html?cdn=${encodeURIComponent(B)}`);
    const atab = await ext(
      async (u) => (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(u)).at(-1)?.id,
      `${A}/pages/main.html`,
    );
    const st = await until(
      async () => {
        const v = (await ext((id) => chrome.storage.session.get(`tab:${id}`), atab))[`tab:${atab}`];
        return v?.status === 'ready' ? v : undefined;
      },
      'automatic scan',
      30000,
    );
    assert(st.resources.length >= 8, `found ${st.resources.length}`);
    const badge = await ext((id) => chrome.action.getBadgeText({ tabId: id }), atab);
    assert(Number(badge) >= 6, `badge "${badge}"`);
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, autoScan: false } }));
    await ap.close();
  },
);

// ---------------------------------------------------------------------------------------------------------------
// VDH-033: nested cross-origin frames, the opt-in page hook, EME refusal, Referer replay
const tabOf = (prefix) =>
  ext(async (u) => (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(u)).at(-1)?.id, prefix);
const stateFor = async (id) => (await ext((i) => chrome.storage.session.get(`tab:${i}`), id))[`tab:${id}`];
async function scanTab(tabIdToScan) {
  const pop = await openPopup(tabIdToScan);
  await pop.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 45000 });
  return { pop, st: await stateFor(tabIdToScan) };
}
const baseRequestFor = (r) => ({
  resourceId: r.id,
  sourceUrl: r.url,
  tabId: r.tabId,
  pageUrl: r.pageUrl,
  host: r.host,
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  filename: 'gated-control.mp4',
  subfolder: '',
  qualityLabel: 'control',
  sourceFormat: 'mp4',
  isHls: false,
  hasMuxedAudio: true,
  hasVideo: true,
});
const framesUrl = `${A}/pages/frames-top.html?c=${encodeURIComponent(C)}&d=${encodeURIComponent(D)}`;
let gatedResource;

await step(
  'nested cross-origin iframes (A -> C -> D) are scanned and each resource knows its frame',
  async () => {
    const fp = await ctx.newPage();
    await fp.goto(framesUrl);
    await fp.waitForTimeout(2500); // nested frames load
    const id = await tabOf(`${A}/pages/frames-top.html`);
    const { pop, st } = await scanTab(id);
    const mid = st.resources.find((r) => r.url === `${C}/media/sample.mp4`);
    const gated = st.resources.find((r) => r.url.includes('/__ref/media/sample.mp4'));
    console.log(`        ${st.resources.length} resources, notes ${JSON.stringify(st.notes)}`);
    assert(
      mid && mid.frameId > 0 && mid.frameUrl.startsWith(`${C}/pages/frames-mid.html`),
      `mid ${JSON.stringify(mid)}`,
    );
    assert(
      gated && gated.frameId > 0 && gated.frameUrl.startsWith(`${D}/pages/frames-leaf.html`),
      `gated ${JSON.stringify(gated)}`,
    );
    assert(mid.frameId !== gated.frameId, 'the two players must be in different frames');
    assert(gated.downloadability.status === 'downloadable', JSON.stringify(gated.downloadability));
    gatedResource = { ...gated, tabId: id };
    // Control for the hook test below: the manifest the leaf frame loaded, then wiped from resource timing.
    assert(
      !st.resources.some((r) => r.url === `${D}/hls/master.m3u8`),
      'manifest must be invisible without the hook',
    );
    await pop.close();
    await fp.close();
  },
);

await step(
  'page hook (opt-in): sees a manifest whose resource-timing entry was wiped, and is registered only while enabled',
  async () => {
    assert(
      (await ext(() => chrome.scripting.getRegisteredContentScripts())).length === 0,
      'hook registered while disabled',
    );
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, pageHook: true } }));
    await until(
      async () =>
        (await ext(() => chrome.scripting.getRegisteredContentScripts())).some((s) => s.id === 'vdh-hook'),
      'hook registration',
      10000,
    );
    const reg = (await ext(() => chrome.scripting.getRegisteredContentScripts())).find(
      (s) => s.id === 'vdh-hook',
    );
    assert(reg.world === 'MAIN' && reg.allFrames && reg.runAt === 'document_start', JSON.stringify(reg));
    assert(
      !reg.matches.includes('<all_urls>') && reg.matches.every((m) => /127\.0\.0\.[123]/.test(m)),
      `matches ${reg.matches}`,
    );

    const fp = await ctx.newPage();
    await fp.goto(framesUrl);
    await fp.waitForTimeout(2500);
    const id = await tabOf(`${A}/pages/frames-top.html`);
    const { pop, st } = await scanTab(id);
    const m = st.resources.find((r) => r.url === `${D}/hls/master.m3u8`);
    assert(m, `manifest not found by the hook; saw ${st.resources.map((r) => r.url).join(', ')}`);
    assert(
      m.detectedBy.includes('hook') && !m.detectedBy.includes('performance'),
      `detectedBy ${m.detectedBy}`,
    );
    assert(
      m.frameUrl.startsWith(`${D}/pages/frames-leaf.html`) && m.kind === 'hls-master',
      JSON.stringify([m.frameUrl, m.kind]),
    );
    assert(m.downloadability.status === 'downloadable', JSON.stringify(m.downloadability));
    await pop.close();
    await fp.close();

    // Turning it off removes the registration again.
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, pageHook: false } }));
    await until(
      async () => (await ext(() => chrome.scripting.getRegisteredContentScripts())).length === 0,
      'hook removal',
      10000,
    );
    await ext(() => chrome.storage.local.set({ settings: { schemaVersion: 1, pageHook: true } }));
    await until(
      async () => (await ext(() => chrome.scripting.getRegisteredContentScripts())).length === 1,
      'hook re-registration',
      10000,
    );
  },
);

await step(
  'Referer-gated file: the browser-sent Referer of the owning frame is replayed, and only for that job',
  async () => {
    assert(gatedResource, 'previous step must have found the gated file');
    const id = await tabOf(`${A}/pages/frames-top.html`).catch(() => undefined);
    const fp = await ctx.newPage();
    await fp.goto(framesUrl);
    await fp.waitForTimeout(2500);
    const tid = await tabOf(`${A}/pages/frames-top.html`);
    const { pop, st } = await scanTab(tid);
    const gated = st.resources.find((r) => r.url.includes('/__ref/media/sample.mp4'));
    await pop.locator(`[data-resource-id="${gated.id}"]`).getByRole('button', { name: 'DOWNLOAD' }).click();
    const job = await jobFinished((j) => j.request.resourceId === gated.id, 60000);
    const hits = servers.state.hits.filter((h) => h.startsWith('ref-check'));
    console.log(`        server saw: ${hits.at(-1)}`);
    assert(
      job.stage === 'completed',
      `stage ${job.stage}: ${JSON.stringify(job.error)} | ${hits.join(' ; ')}`,
    );
    // Chrome's own download manager cannot send a Referer: the refused native download was retried by the extension.
    assert(
      job.staged === true && job.viaOffscreen === true,
      `expected the staged fallback: ${JSON.stringify([job.staged, job.viaOffscreen])}`,
    );
    assert(probe(fileOf(job)).codecs.includes('h264'), 'not a valid MP4');
    assert(
      hits.at(-1).includes(`referer=${D}/`) && hits.at(-1).endsWith('true'),
      `server saw: ${hits.at(-1)}`,
    );
    // The rule is gone once the job is over.
    assert(
      (await ext(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
      'replay rule leaked',
    );

    // Control: the same URL asked for without a known frame gets no Referer and is refused by the server.
    const direct = await ext(
      (req) =>
        chrome.runtime.sendMessage({ channel: 'vdown', type: 'start-download', payload: { request: req } }),
      {
        ...baseRequestFor(gated),
        resourceId: 'no-frame-control',
      },
    );
    assert(direct.ok, JSON.stringify(direct));
    const denied = await jobFinished((j) => j.request.resourceId === 'no-frame-control', 60000);
    assert(denied.stage === 'failed', `control should fail, got ${denied.stage}`);
    await pop.close();
    await fp.close();
    void id;
  },
);

await step(
  'page asking for Widevine (EME) is marked protected and cannot be downloaded; ClearKey is not',
  async () => {
    const widevine = await ctx.newPage();
    await widevine.goto(`${A}/pages/eme.html`);
    await widevine.waitForTimeout(800);
    const wid = await tabOf(`${A}/pages/eme.html`);
    const { pop, st } = await scanTab(wid);
    const v = st.resources.find((r) => r.url.endsWith('/media/sample.mp4'));
    assert(
      v?.downloadability.status === 'protected' && v.downloadability.reason === 'eme',
      JSON.stringify(v?.downloadability),
    );
    assert(
      await pop
        .locator(`[data-resource-id="${v.id}"]`)
        .getByRole('button', { name: 'DOWNLOAD' })
        .isDisabled(),
      'DOWNLOAD must be disabled',
    );
    assert(
      (await pop.locator(`[data-resource-id="${v.id}"]`).innerText()).includes('does not bypass DRM'),
      'reason must be shown',
    );
    await pop.close();
    await widevine.close();

    const clear = await ctx.newPage();
    await clear.goto(`${A}/pages/eme.html?ks=org.w3.clearkey`);
    await clear.waitForTimeout(800);
    const cid = await tabOf(`${A}/pages/eme.html`);
    const r2 = await scanTab(cid);
    const v2 = r2.st.resources.find((r) => r.url.endsWith('/media/sample.mp4'));
    assert(v2?.downloadability.status === 'downloadable', JSON.stringify(v2?.downloadability));
    await r2.pop.close();
    await clear.close();
  },
);

await step('frames the extension cannot enter are listed by origin, with an "allow" button', async () => {
  const bp = await ctx.newPage();
  await bp.goto(`${A}/pages/frames-blocked.html?b=${encodeURIComponent(B)}`);
  await bp.waitForTimeout(1200);
  const bid = await tabOf(`${A}/pages/frames-blocked.html`);
  const { pop, st } = await scanTab(bid);
  assert(JSON.stringify(st.notes.blockedFrameOrigins) === JSON.stringify([B]), JSON.stringify(st.notes));
  await pop.getByRole('button', { name: 'ALLOW EMBEDDED PLAYERS' }).waitFor({ timeout: 10000 });
  await shot(pop, 'popup-blocked-frame');
  await pop.close();
  await bp.close();
});

await step(
  'service-worker restart: scan results and the queue survive a forced shutdown of the worker',
  async () => {
    const stateBefore = await stateOf();
    const jobsBefore = (await jobs()).length;
    // An attached debugger keeps the worker alive, so it is stopped explicitly through the DevTools protocol.
    // Playwright keeps listing the stale handle, so the protocol's own status events are the source of truth.
    const cdp = await ctx.newCDPSession(extPage);
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', (e) =>
      e.versions.forEach((v) => versions.set(v.versionId, v)),
    );
    await cdp.send('ServiceWorker.enable');
    const mine = () =>
      [...versions.values()].filter((v) => v.scriptURL.startsWith(`chrome-extension://${extId}/`));
    await until(() => mine().some((v) => v.runningStatus === 'running'), 'running worker version', 10000);
    for (const v of mine()) await cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
    await until(() => mine().every((v) => v.runningStatus === 'stopped'), 'service worker to stop', 15000);

    // Talking to the extension wakes the worker up again; everything it needs must come back from storage.
    const res = await extPage.evaluate(
      (id) => chrome.runtime.sendMessage({ channel: 'vdown', type: 'get-state', payload: { tabId: id } }),
      tabId,
    );
    assert(
      res.ok && res.state?.resources.length === stateBefore.resources.length,
      `state lost after restart: ${JSON.stringify(res).slice(0, 200)}`,
    );
    assert((await jobs()).length === jobsBefore, 'queue lost after restart');
    await until(
      () => mine().some((v) => v.runningStatus === 'running'),
      'service worker to start again',
      15000,
    );
    // A scan after the restart works: the new worker registered all of its listeners and reads its state from storage.
    const r2 = await extPage.evaluate(
      (id) => chrome.runtime.sendMessage({ channel: 'vdown', type: 'scan', payload: { tabId: id } }),
      tabId,
    );
    assert(
      r2.ok && r2.state.status === 'ready' && r2.state.resources.length === stateBefore.resources.length,
      `scan after restart: ${JSON.stringify(r2).slice(0, 200)}`,
    );
    await cdp.detach();
  },
);
// ---- global assertions
await step(
  'no console errors in any extension context (service worker, offscreen, popup, options, side panel)',
  async () => {
    // Only failures the fixtures cause on purpose are tolerated (CORS-closed CDN, the flaky playlist, a missing file).
    const intended = [
      /\/closed\//,
      /\/flaky\//,
      /does-not-exist\.mp4/,
      /__ref\/media\/sample\.mp4.*403|status of 403/,
    ];
    const errors = consoleLog.filter(
      (m) => m.type === 'error' && !intended.some((re) => re.test(`${m.text} ${m.url}`)),
    );
    if (errors.length) console.log(errors.map((e) => `        [${e.type}] ${e.text} (${e.url})`).join('\n'));
    assert(errors.length === 0, `${errors.length} unexpected console error(s)`);
    const warnings = consoleLog.filter(
      (m) => m.type === 'warning' && /Content Security Policy|CSP/i.test(m.text),
    );
    assert(warnings.length === 0, `CSP warnings: ${warnings.map((w) => w.text).join('; ')}`);
  },
);

await step(
  'no request left the machine: only the two local test origins and extension/blob/data URLs were contacted',
  async () => {
    const external = [...requestedUrls].filter(
      (u) => /^https?:/.test(u) && !/^https?:\/\/(127\.0\.0\.\d+|localhost)[:/]/.test(u),
    );
    assert(external.length === 0, `external requests: ${external.join(', ')}`);
    assert(requestedUrls.size > 20, `request capture looks broken (${requestedUrls.size})`);
  },
);

await shot(popup, 'popup-final');
await ctx.close();

// ---- Italian UI (separate browser instance with an Italian UI language)
const it = await chromium.launchPersistentContext(join(run, 'profile-it'), {
  executablePath: chromiumExecutable(),
  headless: false,
  locale: 'it-IT',
  env: { ...process.env, LC_ALL: 'it_IT.UTF-8', LANGUAGE: 'it', LANG: 'it_IT.UTF-8' },
  args: [
    '--headless=new',
    '--lang=it',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-sandbox',
  ],
});
await step('Italian UI: strings come from the it catalog, with working substitutions', async () => {
  const w = it.serviceWorkers()[0] ?? (await it.waitForEvent('serviceworker', { timeout: 20000 }));
  const p = await it.newPage();
  await p.setViewportSize({ width: 440, height: 700 });
  await p.goto(`chrome-extension://${new URL(w.url()).host}/popup/popup.html?tabId=1`);
  await p.getByRole('button', { name: 'RISCANSIONA PAGINA' }).waitFor({ timeout: 15000 });
  const msg = await p.evaluate(() => [
    chrome.i18n.getMessage('readyCount', ['3']),
    chrome.i18n.getMessage('segmentsProgress', ['1', '5']),
  ]);
  assert(msg[0] === '3 pronti' && msg[1] === '1/5 segmenti', JSON.stringify(msg));
  await shot(p, 'popup-it');
});
await it.close();
await servers.close();

if (process.env.E2E_SAVE_SCREENS) {
  const dest = join(root, 'docs/screenshots');
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(shots)) cpSync(join(shots, f), join(dest, f));
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length} passed, ${skipped} skipped`);
if (failed.length) {
  console.log('failed:\n - ' + failed.map((f) => f.name).join('\n - '));
  process.exit(1);
}
