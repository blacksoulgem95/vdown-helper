// End-to-end test of the browser link: the extension (production build, real Chromium) and the real desktop app,
// talking through Chrome native messaging. The app registers itself with the browser profile, the browser starts it
// through the relay, and every file the app writes is checked with ffprobe and a full decode.
//
//   npm run desktop:ui && cargo build -p vdown-helper-desktop   (the app, window first)
//   xvfb-run -a npm run test:link                               (needs ffmpeg/ffprobe)
//
// VDH_APP points at another build of the app (default: target/debug/vdown-helper).
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumExecutable } from '../scripts/browser.mjs';
import { EXTENSION_ID } from '../scripts/lib/extension-id.mjs';
import { ensureFixtures } from './fixtures.mjs';
import { startServers } from './server.mjs';

const here = import.meta.dirname;
const root = resolve(here, '..');
const app = resolve(
  process.env.VDH_APP ?? join(process.env.CARGO_TARGET_DIR ?? join(root, 'target'), 'debug/vdown-helper'),
);
const HOST = 'io.github.blacksoulgem95.vdownhelper';
if (!existsSync(app)) throw new Error(`No app at ${app}: run cargo build -p vdown-helper-desktop`);
if (!process.env.DISPLAY) throw new Error('No display: run under xvfb-run -a');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}

console.log('> building extension');
execFileSync('node', [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

// --- a fresh user: home, Downloads, the browser profile the app registers itself with ------------------------------
const home = mkdtempSync(join(tmpdir(), 'vdh-link-'));
const config = join(home, '.config');
const profile = join(config, 'chromium'); // the profile is where Chromium looks for this user's native hosts
const downloads = join(home, 'Downloads');
const appOut = join(downloads, 'vdown-helper');
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(downloads, { recursive: true });
writeFileSync(join(config, 'user-dirs.dirs'), `XDG_DOWNLOAD_DIR="${downloads}"\n`);
writeFileSync(
  join(profile, 'Default/Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(home, '.local/share'),
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
};

/** This test's app processes (by their HOME), never anyone else's. */
function appPids() {
  const out = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'vdown-helper') continue;
      // the relay the browser starts is the same program: only the app itself counts
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('chrome-extension://')) continue;
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) out.push(pid);
    } catch {
      // gone meanwhile
    }
  }
  return out;
}
const servers = await startServers(join(here, '.tmp/fixtures'), join(here, 'pages'));
let ctx;
function cleanup() {
  for (const pid of appPids()) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);

ensureFixtures(join(here, '.tmp/fixtures'));
const A = servers.a;
const B = servers.b;

function probe(file) {
  const j = JSON.parse(
    String(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])),
  );
  return {
    video: j.streams.some((s) => s.codec_type === 'video'),
    audio: j.streams.some((s) => s.codec_type === 'audio'),
    duration: Number(j.format.duration),
  };
}
function decodesCleanly(file) {
  const r = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(!String(r).trim(), `${file} does not decode cleanly`);
}

let failures = 0;
let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

console.log(`desktop link E2E (${app})`);

await step('the app registers itself with the browser profile, for this extension only', async () => {
  const p = spawn(app, [], { env, stdio: 'ignore', detached: true });
  const manifest = join(profile, 'NativeMessagingHosts', `${HOST}.json`);
  await until('the host manifest', () => existsSync(manifest), 30_000);
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  assert(m.name === HOST && m.type === 'stdio' && m.path === app, JSON.stringify(m));
  assert(
    JSON.stringify(m.allowed_origins) === JSON.stringify([`chrome-extension://${EXTENSION_ID}/`]),
    'origins',
  );
  // closed again: from here on the browser starts it
  process.kill(-p.pid, 'SIGKILL');
  await until('the app to quit', () => appPids().length === 0, 10_000);
});

// The test build stands in for the user's grants (a prompt automation cannot click): access to the "website" origin,
// and the two optional permissions the desktop app switch asks for.
const extDir = join(home, 'ext');
cpSync(join(root, 'dist'), extDir, { recursive: true });
const extManifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
extManifest.host_permissions = ['http://127.0.0.1/*'];
extManifest.permissions = [...extManifest.permissions, 'nativeMessaging', 'cookies'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(extManifest, null, 2));

async function launch() {
  const c = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumExecutable(),
    headless: false,
    viewport: { width: 1100, height: 900 },
    env,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const sw = c.serviceWorkers()[0] ?? (await c.waitForEvent('serviceworker', { timeout: 20000 }));
  assert(new URL(sw.url()).host === EXTENSION_ID, 'extension id');
  return c;
}
ctx = await launch();
const extUrl = (p) => `chrome-extension://${EXTENSION_ID}/${p}`;
const extPage = await ctx.newPage();
await extPage.goto(extUrl('options/options.html'));
const ext = (fn, arg) => extPage.evaluate(fn, arg);
const jobs = async () => Object.values((await ext(() => chrome.storage.local.get('jobs'))).jobs ?? {});
const jobNamed = (name) => jobs().then((js) => js.find((j) => j.request.filename === name));
const finished = (name, timeoutMs = 90_000) =>
  until(
    `${name} to finish`,
    async () => {
      const j = await jobNamed(name);
      return j && ['completed', 'failed', 'cancelled'].includes(j.stage) ? j : undefined;
    },
    timeoutMs,
  );
await ext(() => chrome.storage.local.set({ desktop: { enabled: true, routing: 'streams' } }));

const page = await ctx.newPage();
await page.goto(`${A}/pages/main.html?cdn=${encodeURIComponent(B)}`);
await page.waitForLoadState('load');
await page.waitForTimeout(1200);
const tabId = await ext(
  async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id,
  `${A}/pages/main.html`,
);
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 440, height: 760 });
const send = (request, desktop) =>
  popup.evaluate(
    ([req, d]) =>
      chrome.runtime.sendMessage({
        channel: 'vdown',
        type: 'start-download',
        payload: { request: req, desktop: d },
      }),
    [request, desktop],
  );
const baseRequest = {
  tabId,
  pageUrl: `${A}/pages/main.html`,
  host: '127.0.0.1',
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  subfolder: '',
  qualityLabel: 'test',
  hasMuxedAudio: true,
  hasVideo: true,
};

await step('the browser starts the app through the relay; Settings show it connected', async () => {
  await extPage.reload();
  await extPage.getByText(/Connected to vdown-helper desktop \d+\.\d+\.\d+/).waitFor({ timeout: 45_000 });
  assert(appPids().length === 1, `expected the app running once, found ${appPids().length}`);
});

await step(
  'an HLS stream goes to the app by default; the queue mirrors its stages and progress',
  async () => {
    await popup.goto(extUrl(`popup/popup.html?tabId=${tabId}`));
    await popup.getByRole('status').filter({ hasText: 'READY' }).waitFor({ timeout: 45_000 });
    const state = (await ext((id) => chrome.storage.session.get(`tab:${id}`), tabId))[`tab:${tabId}`];
    const r = state.resources.find((x) => x.url.endsWith('/hls/master.m3u8'));
    await popup
      .locator(`[data-resource-id="${r.id}"]`)
      .getByRole('button', { name: 'DOWNLOAD', exact: true })
      .click();
    const started = await until('the job', async () =>
      (await jobs()).find((j) => j.request.resourceId === r.id),
    );
    assert(started.viaDesktop === true, 'not handed to the desktop app');
    await popup.getByText('In desktop app').first().waitFor({ timeout: 20_000 });
    const done = await finished(started.request.filename);
    assert(done.stage === 'completed', `stage ${done.stage}: ${JSON.stringify(done.error)}`);
    assert(done.filePath?.startsWith(appOut) && existsSync(done.filePath), `file ${JSON.stringify(done)}`);
    assert(done.chromeDownloadId === undefined, 'went through Chrome downloads');
    const p = probe(done.filePath);
    assert(p.video && p.audio, JSON.stringify(p));
    decodesCleanly(done.filePath);
  },
);

await step('Send to desktop app on a direct file card', async () => {
  const state = (await ext((id) => chrome.storage.session.get(`tab:${id}`), tabId))[`tab:${tabId}`];
  const r = state.resources.find((x) => x.url.endsWith('/media/sample.mp4'));
  await popup
    .locator(`[data-resource-id="${r.id}"]`)
    .getByRole('button', { name: 'Send to desktop app' })
    .click();
  const started = await until('the job', async () =>
    (await jobs()).find((j) => j.request.resourceId === r.id && j.viaDesktop),
  );
  const done = await finished(started.request.filename);
  assert(done.stage === 'completed', `stage ${done.stage}: ${JSON.stringify(done.error)}`);
  assert(done.filePath?.startsWith(appOut), `file ${done.filePath}`);
  decodesCleanly(done.filePath);
});

await step(
  'the cookies of a site the user allowed go with its job (and only then does the server answer)',
  async () => {
    const url = `${A}/__cookie/media/sample.mp4`;
    assert((await fetch(url)).status === 403, 'the fixture must refuse a request without the cookie');
    await ctx.addCookies([{ name: 'e2e_session', value: 'granted', url: A }]);
    const res = await send(
      {
        ...baseRequest,
        resourceId: 'cookie',
        sourceUrl: url,
        filename: 'signed-in.mp4',
        sourceFormat: 'mp4',
        isHls: false,
      },
      true,
    );
    assert(res.ok, JSON.stringify(res));
    const done = await finished('signed-in.mp4');
    assert(done.stage === 'completed', `stage ${done.stage}: ${JSON.stringify(done.error)}`);
    decodesCleanly(done.filePath);
  },
);

/** A second port to the app from the extension's page: what the app says about a job (protocol v1, `status`). */
const appStatus = (jobId) =>
  ext(
    (id) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connectNative('io.github.blacksoulgem95.vdownhelper');
        port.onMessage.addListener((m) => {
          if (m.type === 'hello') port.postMessage({ v: 1, type: 'status', jobIds: [id] });
          if (m.type === 'status') {
            port.disconnect();
            resolve(m.jobs[0]);
          }
        });
        port.postMessage({ v: 1, type: 'hello', extVersion: 'e2e' });
      }),
    jobId,
  );

await step('cancel in the extension stops the job in the app; nothing is saved', async () => {
  const res = await send({
    ...baseRequest,
    resourceId: 'slow-cancel',
    sourceUrl: `${B}/slow/hls/v360/index.m3u8`,
    filename: 'cancel-me.ts',
    container: 'ts',
    sourceFormat: 'hls',
    isHls: true,
  });
  assert(res.ok, JSON.stringify(res));
  const job = await until('downloading in the app', async () => {
    const j = await jobNamed('cancel-me.ts');
    return j?.viaDesktop && j.stage === 'downloading' ? j : undefined;
  });
  assert(
    (
      await ext(
        (id) =>
          chrome.runtime.sendMessage({
            channel: 'vdown',
            type: 'job-action',
            payload: { jobId: id, action: 'cancel' },
          }),
        job.id,
      )
    ).ok,
    'cancel',
  );
  assert((await finished('cancel-me.ts')).stage === 'cancelled', 'not cancelled');
  await until('the app to cancel it', async () => (await appStatus(job.id))?.stage === 'cancelled', 15_000);
  await sleep(1500);
  assert(!readdirSync(appOut).some((f) => f.startsWith('cancel-me')), 'a file appeared after cancel');
});

await step('a forged request for a DRM stream is refused by the app itself', async () => {
  const reply = await ext(
    (req) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connectNative('io.github.blacksoulgem95.vdownhelper');
        const seen = [];
        port.onMessage.addListener((m) => {
          seen.push(m.type);
          if (m.type === 'hello')
            port.postMessage({ v: 1, type: 'run-job', jobId: 'forged-drm', request: req, headers: {} });
          if (m.type === 'error' && m.jobId === 'forged-drm') {
            port.disconnect();
            resolve({ code: m.code, seen });
          }
        });
        setTimeout(() => resolve({ code: 'timeout', seen }), 30_000);
        port.postMessage({ v: 1, type: 'hello', extVersion: 'e2e' });
      }),
    {
      ...baseRequest,
      resourceId: 'drm',
      // the request claims a plain stream; the playlist says otherwise, and the app reads the playlist itself
      sourceUrl: `${A}/hls-drm/index.m3u8`,
      filename: 'forged.ts',
      container: 'ts',
      sourceFormat: 'hls',
      isHls: true,
    },
  );
  assert(reply.code === 'protected', `the app answered ${JSON.stringify(reply)}`);
  assert(!readdirSync(appOut).some((f) => f.startsWith('forged')), 'a protected stream was saved');
});

await step('a job keeps running in the app after the browser closes', async () => {
  const res = await send({
    ...baseRequest,
    resourceId: 'outlive',
    sourceUrl: `${B}/slow/hls/v360/index.m3u8`,
    filename: 'outlives-the-browser.ts',
    container: 'ts',
    sourceFormat: 'hls',
    isHls: true,
  });
  assert(res.ok, JSON.stringify(res));
  await until(
    'downloading in the app',
    async () => (await jobNamed('outlives-the-browser.ts'))?.stage === 'downloading',
  );
  const app = appPids();
  await ctx.close();
  ctx = undefined;
  const file = await until(
    'the file the app finishes',
    () => readdirSync(appOut).find((f) => f.startsWith('outlives-the-browser') && f.endsWith('.ts')),
    60_000,
  );
  assert(appPids().join() === app.join(), 'the app did not survive the browser');
  const path = join(appOut, file);
  assert(statSync(path).size > 0, 'empty');
  assert(probe(path).video, 'no video');
  decodesCleanly(path);
});

await ctx?.close().catch(() => {});
await servers.close();
console.log(`\n${passed}/${passed + failures} passed`);
process.exit(failures ? 1 : 0);
