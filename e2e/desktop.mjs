// End-to-end test of the real desktop app (Linux): the built binary driven through tauri-driver and WebKitWebDriver,
// against the extension's fixture servers. Every file is checked with ffprobe and a full decode.
//
//   cargo build -p vdown-helper-desktop && npm run desktop:ui   (the window must be built first)
//   xvfb-run -a npm run test:desktop                            (needs tauri-driver, WebKitWebDriver, ffmpeg)
//
// VDH_APP points at another build of the app (default: target/debug/vdown-helper).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '..');
const app = resolve(
  process.env.VDH_APP ?? join(process.env.CARGO_TARGET_DIR ?? join(root, 'target'), 'debug/vdown-helper'),
);
const PORT = 4444;
const WD = `http://127.0.0.1:${PORT}`;
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

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

// --- environment: a fresh home, so the app starts with an empty queue, history and settings -----------------------
const home = mkdtempSync(join(tmpdir(), 'vdh-app-'));
const downloads = join(home, 'Downloads');
mkdirSync(join(home, '.config'), { recursive: true });
mkdirSync(downloads, { recursive: true });
writeFileSync(join(home, '.config/user-dirs.dirs'), `XDG_DOWNLOAD_DIR="${downloads}"\n`);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
  // English whatever the machine's language (C.UTF-8 exists everywhere)
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
};

const children = [];
function cleanup() {
  // each child leads its own process group: tauri-driver's WebKitWebDriver and the app go with it
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function fixtures() {
  const p = spawn('node', [join(root, 'e2e/fixture-server.mjs')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: true,
  });
  children.push(p);
  const line = await new Promise((res, rej) => {
    createInterface({ input: p.stdout }).once('line', res);
    p.once('exit', () => rej(new Error('the fixture server stopped')));
  });
  return JSON.parse(line);
}

async function driver() {
  const p = spawn('tauri-driver', ['--port', String(PORT)], {
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  children.push(p);
  await until('tauri-driver', async () => (await fetch(`${WD}/status`)).ok);
}

// --- a minimal W3C WebDriver client --------------------------------------------------------------------------------
async function wd(method, path, body) {
  const r = await fetch(`${WD}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j.value)}`);
  return j.value;
}

class Session {
  static async open() {
    const v = await wd('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application: app } } },
    });
    const s = new Session(v.sessionId);
    await s.find('[data-testid="app"]', 60_000);
    return s;
  }
  constructor(id) {
    this.base = `/session/${id}`;
  }
  async close() {
    await wd('DELETE', this.base);
  }
  async all(css) {
    const v = await wd('POST', `${this.base}/elements`, { using: 'css selector', value: css });
    return v.map((e) => e[ELEMENT]);
  }
  async find(css, timeoutMs) {
    return until(css, async () => (await this.all(css))[0], timeoutMs);
  }
  async text(css, timeoutMs) {
    const el = await this.find(css, timeoutMs);
    return wd('GET', `${this.base}/element/${el}/text`);
  }
  async click(css) {
    await wd('POST', `${this.base}/element/${await this.find(css)}/click`, {});
  }
  async type(css, text) {
    const el = await this.find(css);
    await wd('POST', `${this.base}/element/${el}/clear`, {});
    await wd('POST', `${this.base}/element/${el}/value`, { text });
  }
  async script(source, ...args) {
    return wd('POST', `${this.base}/execute/sync`, { script: source, args });
  }
  /** Click the button whose text matches (tabs, Save...). */
  async button(re, timeoutMs) {
    await until(
      `button ${re}`,
      () =>
        this.script(
          `const re = new RegExp(arguments[0], 'i');
           const b = [...document.querySelectorAll('button')].find((x) => re.test(x.textContent || '') || re.test(x.getAttribute('aria-label') || ''));
           if (b) b.click();
           return Boolean(b);`,
          re.source,
        ),
      timeoutMs,
    );
  }
  /** Set a <select> the way a user does (React sees the change). */
  async choose(css, value) {
    await this.find(css);
    await this.script(
      `const s = document.querySelector(arguments[0] + ' select') || document.querySelector(arguments[0]);
       const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
       set.call(s, arguments[1]);
       s.dispatchEvent(new Event('change', { bubbles: true }));`,
      css,
      value,
    );
  }
}

// --- checks on the files -------------------------------------------------------------------------------------------
function files(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile());
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const j = JSON.parse(String(out));
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
  if (String(r).trim()) throw new Error(`${file} does not decode cleanly: ${r}`);
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

// --- the run -------------------------------------------------------------------------------------------------------
const f = await fixtures();
await driver();
let s = await Session.open();
console.log(`desktop app E2E (${app})`);

await step('an HLS master playlist shows its qualities and downloads as a playable MP4', async () => {
  await s.type('input[data-testid="url"]', `${f.a}/hls/master.m3u8`);
  await s.click('[data-testid="check"]');
  await s.find('[data-testid="probed"]');
  const options = await s.script(
    `return document.querySelectorAll('select[data-testid="quality"] option').length`,
  );
  if (options < 2) throw new Error(`expected several qualities, got ${options}`);
  await s.click('[data-testid="add"]');
  await until('the job to be queued', async () => /Added/.test(await s.text('[data-testid="add-message"]')));
  await s.button(/^History/);
  await s.find('[data-testid="history"] li[data-stage="completed"]', 120_000);
  const out = files(downloads).filter((p) => p.endsWith('.mp4'));
  if (out.length !== 1) throw new Error(`expected one MP4 in Downloads, found ${out.join(', ') || 'none'}`);
  const p = probe(out[0]);
  if (!p.video || !p.audio) throw new Error(`expected video and audio: ${JSON.stringify(p)}`);
  decodesCleanly(out[0]);
});

await step('a DRM-protected stream is refused', async () => {
  await s.type('input[data-testid="url"]', `${f.a}/hls-drm/index.m3u8`);
  await s.click('[data-testid="check"]');
  await until('the refusal', async () => /protected/i.test(await s.text('[data-testid="add-message"]')));
  if ((await s.all('[data-testid="probed"]')).length)
    throw new Error('a protected stream was offered for download');
});

await step('a live recording runs until Stop and keeps what was recorded', async () => {
  const before = new Set(files(downloads));
  await s.type('input[data-testid="url"]', `${f.a}/__live/hls/index.m3u8?id=app${process.pid}&len=60`);
  await s.click('[data-testid="check"]');
  await s.find('[data-testid="probed"]');
  await s.click('[data-testid="add"]');
  await s.button(/^Queue/);
  await until('the recording', () =>
    s.script(
      `return [...document.querySelectorAll('[data-testid="queue"] [aria-label]')].some((b) => /stop/i.test(b.getAttribute('aria-label')))`,
    ),
  );
  await sleep(5000);
  await s.button(/^Stop and save$/);
  await s.button(/^History/);
  await until(
    'the recording in the history',
    async () => (await s.all('[data-testid="history"] li[data-stage="completed"]')).length === 2,
    60_000,
  );
  const recorded = files(downloads).filter((p) => !before.has(p));
  if (recorded.length !== 1)
    throw new Error(`expected one recording, found ${recorded.join(', ') || 'none'}`);
  const p = probe(recorded[0]);
  if (!(p.duration >= 2)) throw new Error(`recorded ${p.duration}s`);
  decodesCleanly(recorded[0]);
});

await step('settings are saved and survive a restart (language, history)', async () => {
  await s.button(/^Settings/);
  await s.find('[data-testid="settings"]');
  await s.script(
    `const sel = [...document.querySelectorAll('[data-testid="settings"] select')].pop();
     const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
     set.call(sel, 'it');
     sel.dispatchEvent(new Event('change', { bubbles: true }));`,
  );
  await s.button(/^Save$/);
  await s.find('[data-testid="app"][data-lang="it"]');
  await s.close();
  s = await Session.open();
  await s.find('[data-testid="app"][data-lang="it"]');
  await s.button(/^Cronologia/);
  const done = await s.all('[data-testid="history"] li[data-stage="completed"]');
  if (done.length !== 2) throw new Error(`the history has ${done.length} completed entries after a restart`);
});

await s.close().catch(() => {});
console.log(`\n${passed}/${passed + failures} passed`);
process.exit(failures ? 1 : 0);
