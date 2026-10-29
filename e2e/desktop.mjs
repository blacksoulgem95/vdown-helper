// End-to-end test of the real desktop app (Linux): the built binary driven through tauri-driver and WebKitWebDriver,
// against the extension's fixture servers. Every file is checked with ffprobe and a full decode (re-encodes also for
// their codecs).
//
//   cargo build -p vdown-helper-desktop && npm run desktop:ui   (the window must be built first)
//   xvfb-run -a npm run test:desktop                            (needs tauri-driver, WebKitWebDriver, ffmpeg)
//
// VDH_APP points at another build of the app (default: target/debug/vdown-helper).
import { execFileSync, spawn } from 'node:child_process';
import {
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
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
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
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // the document portal's mount under .cache/doc can still be going away: a temporary folder, left to the system
  }
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

// The driver (and so the app) runs in its own D-Bus session: the app's single-instance lock and its notifications use
// it, and dbus-monitor records the notifications the app sends.
const busFile = join(home, 'bus');
const notifyLog = join(home, 'notifications.log');
async function driver() {
  const script = `echo "$DBUS_SESSION_BUS_ADDRESS" > '${busFile}'
dbus-monitor --session "interface='org.freedesktop.Notifications',member='Notify'" > '${notifyLog}' 2>&1 &
exec tauri-driver --port ${PORT}`;
  const p = spawn('dbus-run-session', ['--', 'sh', '-c', script], {
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  children.push(p);
  await until('tauri-driver', async () => (await fetch(`${WD}/status`)).ok);
}
const busEnv = () => ({ ...env, DBUS_SESSION_BUS_ADDRESS: readFileSync(busFile, 'utf8').trim() });
/** The app processes running now (the one the driver started, and any other). */
const appPids = () => {
  try {
    return String(execFileSync('pgrep', ['-x', 'vdown-helper']))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
};

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
    // WebKitWebDriver's clear empties the field without the input event React listens to, so React could keep the old
    // text and the new one was typed after it (VDH-078): empty it the way a user's edit does, then type
    await this.script(
      `const i = document.querySelector(arguments[0]);
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '');
       i.dispatchEvent(new Event('input', { bubbles: true }));`,
      css,
    );
    await wd('POST', `${this.base}/element/${el}/value`, { text });
    const now = await this.script('return document.querySelector(arguments[0]).value', css);
    if (now !== text) throw new Error(`typed ${text} into ${css}, which holds ${now}`);
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
  /** Flip the switch labelled `re`. */
  async toggle(re) {
    const ok = await this.script(
      `const re = new RegExp(arguments[0], 'i');
       const l = [...document.querySelectorAll('label')].find((x) => re.test(x.textContent || ''));
       const sw = l && document.getElementById(l.htmlFor);
       if (sw) sw.click();
       return Boolean(sw);`,
      re.source,
    );
    if (!ok) throw new Error(`no switch ${re}`);
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
    codecs: j.streams.map((s) => s.codec_name),
    height: j.streams.find((s) => s.codec_type === 'video')?.height,
  };
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

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

await step('a system notification says the download finished', async () => {
  await until(
    'the notification',
    () => readFileSync(notifyLog, 'utf8').includes('Download finished'),
    15_000,
  );
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
  await s.find('[data-testid="probed"]').catch(async (e) => {
    // what the window shows instead (an error, a button still busy...)
    const seen = await s.script(
      `return JSON.stringify({
         url: document.querySelector('input[data-testid="url"]')?.value,
         message: document.querySelector('[data-testid="add-message"]')?.textContent,
         check: document.querySelector('[data-testid="check"]')?.textContent,
         busy: document.querySelector('[data-testid="check"]')?.disabled,
       })`,
    );
    throw new Error(`${e.message}; the window shows ${seen}`);
  });
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

/** Choose a finished file for re-encoding from its History entry. */
async function reencodeFromHistory(name) {
  await s.button(/^History/);
  await s.find('[data-testid="history"]');
  const ok = await s.script(
    `const li = [...document.querySelectorAll('[data-testid="history"] li')].find((x) => x.querySelector('p')?.title === arguments[0]);
     const b = li && li.querySelector('[data-testid="history-reencode"]');
     if (b) b.click();
     return Boolean(b);`,
    name,
  );
  if (!ok) throw new Error(`no Re-encode on the History entry ${name}`);
  await s.find('[data-testid="convert"]');
}

const completed = async () => (await s.all('[data-testid="history"] li[data-stage="completed"]')).length;

let firstMp4 = '';
await step('a finished download is re-encoded to H.265 in MKV, and the original is kept', async () => {
  firstMp4 = files(downloads).filter((p) => p.endsWith('.mp4'))[0] ?? '';
  if (!firstMp4) throw new Error('no finished MP4 to re-encode');
  const before = sha(firstMp4);
  await reencodeFromHistory(basename(firstMp4));
  await until('one file chosen', async () => (await s.all('[data-testid="convert-inputs"] li')).length === 1);
  // the codecs offered are the ones that work here (detected with test encodes)
  await until('the encoders', () =>
    s.script(
      `return [...document.querySelectorAll('select[data-testid="codec"] option')].some((o) => o.value === 'h265')`,
    ),
  );
  await s.choose('[data-testid="codec"]', 'h265');
  await s.choose('[data-testid="container"]', 'mkv');
  // an encode the container cannot hold is refused before it is queued
  await s.choose('[data-testid="container"]', 'webm');
  await s.find('[data-testid="encode-problem"][data-code="container-codec"]');
  if ((await s.script(`return document.querySelector('[data-testid="reencode"]').disabled`)) !== true)
    throw new Error('an impossible encode could be started');
  await s.choose('[data-testid="container"]', 'mkv');
  // the starting point (Compatible) stops at 1080p: keep the original size
  await s.choose('[data-testid="size"]', '0');
  await until(
    'the encode to be possible',
    async () => (await s.all('[data-testid="encode-problem"]')).length === 0,
  );
  await s.click('[data-testid="reencode"]');
  await s.find('[data-testid="queue"]');
  await s.button(/^History/);
  await until('the re-encode in the history', async () => (await completed()) === 3, 120_000);
  const out = files(downloads).filter((p) => p.endsWith('[H.265].mkv'));
  if (out.length !== 1) throw new Error(`expected one H.265 file, found ${out.join(', ') || 'none'}`);
  const p = probe(out[0]);
  if (p.codecs.join() !== 'hevc,aac') throw new Error(`codecs ${p.codecs.join()}`);
  if (Math.abs(p.duration - probe(firstMp4).duration) > 0.5) throw new Error(`duration ${p.duration}`);
  decodesCleanly(out[0]);
  if (sha(firstMp4) !== before) throw new Error('the original file changed');
  await until(
    'the notification',
    () => readFileSync(notifyLog, 'utf8').includes('Re-encode finished'),
    15_000,
  );
});

await step('a batch of files is re-encoded with the Compatible preset', async () => {
  const h265 = files(downloads).find((p) => p.endsWith('[H.265].mkv'));
  if (!firstMp4 || !h265) throw new Error('the files of the step before are missing');
  await reencodeFromHistory(basename(firstMp4));
  await reencodeFromHistory(basename(h265));
  await until(
    'two files chosen',
    async () => (await s.all('[data-testid="convert-inputs"] li')).length === 2,
  );
  await s.choose('[data-testid="preset"]', 'compatible');
  await until('the encoders', () =>
    s.script(`return !document.querySelector('[data-testid="reencode"]').disabled`),
  );
  await s.click('[data-testid="reencode"]');
  await s.find('[data-testid="queue"]');
  await s.button(/^History/);
  await until('both re-encodes in the history', async () => (await completed()) === 5, 180_000);
  const out = files(downloads).filter((p) => p.endsWith('[Compatible].mp4'));
  if (out.length !== 2) throw new Error(`expected two Compatible files, found ${out.join(', ') || 'none'}`);
  for (const file of out) {
    const p = probe(file);
    if (p.codecs.join() !== 'h264,aac') throw new Error(`${basename(file)}: codecs ${p.codecs.join()}`);
    if (!(p.height <= 1080)) throw new Error(`${basename(file)}: height ${p.height}`);
    decodesCleanly(file);
  }
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
  if (done.length !== 5) throw new Error(`the history has ${done.length} completed entries after a restart`);
});

await step('start at login is registered when turned on and removed when turned off', async () => {
  const entries = () =>
    existsSync(join(home, '.config/autostart'))
      ? files(join(home, '.config/autostart')).filter((f) => f.endsWith('.desktop'))
      : [];
  if (entries().length) throw new Error('registered before the user asked');
  await s.button(/^Impostazioni/);
  await s.toggle(/^Avvia all'accesso/);
  await s.button(/^Salva$/);
  const entry = await until('the autostart entry', () => entries()[0]);
  if (!/--hidden/.test(readFileSync(entry, 'utf8'))) throw new Error('the app would not start in the tray');
  await s.toggle(/^Avvia all'accesso/);
  await s.button(/^Salva$/);
  await until('the entry to go', () => entries().length === 0);
});

await step('closing the window keeps the app (and its queue) running in the tray', async () => {
  const before = appPids();
  // what a window manager's close button sends (WebDriver's own close would end the session instead)
  const asked = String(
    execFileSync('python3', ['-I', join(root, 'e2e/wm-close.py'), 'vdown-helper'], { env }),
  );
  if (Number(asked) < 1) throw new Error('the app window was not found');
  await sleep(2000);
  if (appPids().join() !== before.join()) throw new Error('the app quit when its window was closed');
  // hidden, not gone: the page is still there and says it is not visible
  await until(
    'the window to hide',
    async () => (await s.script('return document.visibilityState')) === 'hidden',
  );
});

await step('a second launch brings the running app window back and exits', async () => {
  const before = appPids();
  if (before.length !== 1) throw new Error(`expected one app, found ${before.length}`);
  const second = spawn(app, [], { env: busEnv(), stdio: 'ignore' });
  const code = await new Promise((res) => {
    const t = setTimeout(() => res('still running'), 15_000);
    second.once('exit', (c) => {
      clearTimeout(t);
      res(c);
    });
  });
  if (code !== 0) {
    second.kill('SIGKILL');
    throw new Error(`the second launch: ${code}`);
  }
  if (appPids().join() !== before.join()) throw new Error('the running app did not survive');
  // the running app brings its window back (it was closed to the tray by the step before)
  await until(
    'the window to show',
    async () => (await s.script('return document.visibilityState')) === 'visible',
  );
});

await s.close().catch(() => {});
console.log(`\n${passed}/${passed + failures} passed`);
process.exit(failures ? 1 : 0);
