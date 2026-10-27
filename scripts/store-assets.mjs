// Chrome Web Store images and site screenshots, rendered from the REAL extension on labelled demo pages (store/pages)
// with media made locally (store/demo-media.mjs). Per language (en, it):
//   store-assets/<lang>/0N-*.png        5 screenshots, 1280 x 800
//   store-assets/<lang>/promo-small.png small promo tile, 440 x 280
//   store-assets/<lang>/marquee.png     marquee, 1400 x 560
// Every file is checked: exact size, 24-bit RGB, no alpha (the store's rules).
//
//   npm run store:assets            (needs ffmpeg/ffprobe on PATH, like the E2E suite)
//   npm run store:assets -- --no-build --lang=en
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumExecutable } from './browser.mjs';
import { ensureFixtures } from '../e2e/fixtures.mjs';
import { startServers } from '../e2e/server.mjs';
import { ensureDemoMedia } from '../store/demo-media.mjs';
import { heroHtml, marqueeHtml, promoHtml, screenshotHtml } from '../store/templates.mjs';

const root = resolve(import.meta.dirname, '..');
// Words on the images, per language (no service names, no promise of "all sites", honest about DRM).
const COPY = JSON.parse(readFileSync(join(root, 'store/copy.json'), 'utf8'));
const tmp = join(root, 'store/.tmp');
const outRoot = join(root, 'store-assets');
const args = process.argv.slice(2);
const langs = (args.find((a) => a.startsWith('--lang='))?.slice(7) ?? 'en,it').split(',');

if (!args.includes('--no-build'))
  execFileSync('node', [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const fixtures = join(root, 'e2e/.tmp/fixtures');
ensureFixtures(fixtures);
ensureDemoMedia(fixtures);
const servers = await startServers(fixtures, join(root, 'store/pages'));
const A = servers.a;
const C = servers.c;

// The same unpacked build the E2E suite uses, with the demo origins allowed up front (no permission prompts to click).
const extDir = join(tmp, 'ext');
rmSync(extDir, { recursive: true, force: true });
cpSync(join(root, 'dist'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://127.0.0.2/*', 'http://127.0.0.3/*'];
manifest.permissions = [...manifest.permissions, 'declarativeNetRequestWithHostAccess'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const dataUri = (file, type = 'image/png') => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const fontCss = () => {
  const nm = join(root, 'node_modules');
  const face = (family, file, weight) =>
    `@font-face{font-family:'${family}';font-weight:${weight};src:url(${dataUri(join(nm, file), 'font/woff2')}) format('woff2');}`;
  return (
    face('Inter Variable', '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', '100 900') +
    face('JetBrains Mono', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 400) +
    face('JetBrains Mono', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2', 700)
  );
};

const until = async (fn, what, ms = 30000, every = 200) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
};

/** Drive the extension on the demo pages and save the raw UI captures (2x) for one language. */
async function capture(lang, raw) {
  const profile = join(tmp, `profile-${lang}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(join(profile, 'Default'), { recursive: true });
  const downloads = join(tmp, `downloads-${lang}`);
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(
    join(profile, 'Default/Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  const it = lang === 'it';
  // Chrome is started here and Playwright attaches to it: a Playwright-launched browser saves downloads under random
  // names, and the queue in the screenshots must show the names a user would see.
  const proc = spawn(
    chromiumExecutable() ?? 'chromium',
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--lang=${lang}`,
      '--force-device-scale-factor=2',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      // The UI language comes from --lang/LANGUAGE; the locale stays UTF-8 even where it_IT is not installed (Chrome
      // would otherwise write file names in ASCII).
      env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', ...(it ? { LANGUAGE: 'it' } : {}) },
    },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  const port = await until(
    () => (existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n')[0] : undefined),
    'Chrome to start',
  );
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  try {
    const session = await browser.newBrowserCDPSession();
    // Back to Chrome's own behaviour (the profile's download folder, the names the extension asks for): Playwright
    // otherwise takes over downloads and names them at random.
    await session.send('Browser.setDownloadBehavior', { behavior: 'default' });
    // Chrome runs component extensions of its own. An unpacked extension's id is derived from its folder path.
    const id = createHash('sha256')
      .update(realpathSync(extDir))
      .digest('hex')
      .slice(0, 32)
      .replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    const ours = (w) => w.url().startsWith(`chrome-extension://${id}/`);
    const sw =
      ctx.serviceWorkers().find(ours) ??
      (await ctx.waitForEvent('serviceworker', { predicate: ours, timeout: 20000 }));
    const extUrl = (p) => `chrome-extension://${new URL(sw.url()).host}/${p}`;
    const extPage = await ctx.newPage();
    await extPage.goto(extUrl('options/options.html'));
    const ext = (fn, arg) => extPage.evaluate(fn, arg);
    const tabOf = (prefix) =>
      until(
        () => ext(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, prefix),
        `tab ${prefix}`,
      );
    const stateOf = async (id) => (await ext((i) => chrome.storage.session.get(`tab:${i}`), id))[`tab:${id}`];
    const jobs = async () => Object.values((await ext(() => chrome.storage.local.get('jobs'))).jobs ?? {});

    const openPage = async (path) => {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 1280, height: 800 });
      await p.goto(`${A}/pages/${path}${path.includes('?') ? '&' : '?'}lang=${lang}`);
      await p.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
      await p.waitForTimeout(1200); // posters and the embedded frame paint
      return { p, id: await tabOf(`${A}/pages/${path.split('?')[0]}`) };
    };
    const openPopup = async (id) => {
      const pop = await ctx.newPage();
      await pop.setViewportSize({ width: 420, height: 600 });
      await pop.goto(extUrl(`popup/popup.html?tabId=${id}`));
      await until(async () => (await stateOf(id))?.status === 'ready', 'scan', 45000);
      await pop.waitForTimeout(2500); // probes fill in sizes and durations
      return pop;
    };
    const shot = async (p, name) => {
      await p.bringToFront();
      await p.screenshot({ path: join(raw, `${name}.png`) });
    };
    const scrollMain = (pop, to) =>
      pop.evaluate((y) => {
        const m = document.querySelector('main');
        m.scrollTop = y === 'end' ? m.scrollHeight : y;
      }, to);

    // 1. The demo video page and what the popup finds on it.
    const demo = await openPage(`demo.html?embed=${encodeURIComponent(C)}`);
    await shot(demo.p, 'page-demo');
    let pop = await openPopup(demo.id);
    await shot(pop, 'popup-detect');
    const st = await stateOf(demo.id);
    const master = st.resources.find((r) => r.url.endsWith('/demo/hls/master.m3u8'));
    if (!master) throw new Error('the demo HLS stream was not detected');

    // 2. The Studio on that stream.
    const studio = await ctx.newPage();
    await studio.setViewportSize({ width: 440, height: 1000 });
    await studio.goto(extUrl('sidepanel/sidepanel.html'));
    await studio.evaluate((sel) => chrome.storage.session.set({ 'studio:selection': sel }), {
      tabId: demo.id,
      resourceId: master.id,
      at: Date.now(),
    });
    await studio.getByRole('heading', { name: master.title }).first().waitFor({ timeout: 20000 });
    await studio.waitForTimeout(1500);
    await shot(studio, 'studio');

    // 3. One click on the best match, then the queue with the finished file.
    const before = (await jobs()).length;
    await pop
      .locator('[data-best="true"]')
      .getByRole('button', { name: /^(DOWNLOAD|SCARICA)$/ })
      .click();
    await until(async () => (await jobs()).length > before, 'a queued job');
    await until(
      async () => (await jobs()).some((j) => j.stage === 'completed'),
      'a finished download',
      120000,
    );
    // Chrome names the file as a user would get it: it must keep the extension the extension asked for.
    const saved = await until(
      () => readdirSync(downloads).find((f) => f.includes('[1080p]') && !f.endsWith('.crdownload')),
      'the saved file',
    );
    if (!saved.endsWith('.ts')) throw new Error(`the stream was saved as "${saved}", expected .ts`);
    await pop.close();
    pop = await openPopup(demo.id);
    await shot(pop, 'popup-after');
    await scrollMain(pop, 'end');
    await pop.waitForTimeout(400);
    await shot(pop, 'popup-queue');
    await pop.close();

    // 4. A live stream: RECORD, a few seconds of recording, then stop and save.
    await fetch(`${A}/__live/start?id=demo-${lang}`, { method: 'POST' });
    const live = await openPage(`demo-live.html?id=demo-${lang}`);
    await shot(live.p, 'page-live');
    pop = await openPopup(live.id);
    const liveCard = pop.locator('[data-resource-id]').first();
    await liveCard.getByRole('button', { name: /^(RECORD|REGISTRA)$/ }).click();
    await until(async () => (await jobs()).some((j) => j.stage === 'recording'), 'a recording', 20000);
    await pop.close();
    await new Promise((r) => setTimeout(r, 6000));
    pop = await openPopup(live.id);
    await shot(pop, 'popup-live');
    const rec = (await jobs()).find((j) => j.stage === 'recording');
    if (rec)
      await ext(
        (id) =>
          chrome.runtime.sendMessage({
            channel: 'vdown',
            type: 'job-action',
            payload: { jobId: id, action: 'stop' },
          }),
        rec.id,
      );
    await pop.close();

    // 5. A page with a DRM-protected film and a free trailer.
    const members = await openPage('demo-members.html');
    await shot(members.p, 'page-members');
    pop = await openPopup(members.id);
    await shot(pop, 'popup-members');
    await pop.close();
  } finally {
    await browser.close().catch(() => undefined);
    proc.kill();
  }
}

/** The site's images as WebP (a tenth of the PNG's weight; transparency kept). */
function webp(from, to) {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    from,
    '-c:v',
    'libwebp',
    '-quality',
    '84',
    '-pix_fmt',
    'yuva420p',
    to,
  ]);
}

/** Render the site's hero art: transparent PNG at 2x, for sharp text on high-density screens. */
async function renderSiteArt(browser, html, width, height, file) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, type: 'png', omitBackground: true });
  await page.close();
  console.log(`  ${file.slice(root.length + 1)}  ${width * 2}x${height * 2}, transparent`);
}

/** Render one canvas and save it as 24-bit RGB PNG (no alpha), then check it. */
async function render(browser, html, width, height, file) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const rgba = `${file}.rgba.png`;
  await page.screenshot({ path: rgba, type: 'png' });
  await page.close();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', rgba, '-pix_fmt', 'rgb24', file]);
  rmSync(rgba);
  const probe = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,pix_fmt',
    '-of',
    'csv=p=0',
    file,
  ])
    .toString()
    .trim();
  if (probe !== `${width},${height},rgb24`)
    throw new Error(`${file}: ${probe}, expected ${width},${height},rgb24`);
  console.log(`  ${file.slice(root.length + 1)}  ${probe}`);
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
try {
  const fonts = fontCss();
  const logo = dataUri(join(root, 'public/logo.svg'), 'image/svg+xml');
  for (const lang of langs) {
    const copy = COPY[lang];
    if (!copy) throw new Error(`no copy for ${lang}`);
    const raw = join(tmp, lang, 'raw');
    rmSync(raw, { recursive: true, force: true });
    mkdirSync(raw, { recursive: true });
    console.log(`> ${lang}: driving the extension on the demo pages`);
    await capture(lang, raw);
    const img = (name) => dataUri(join(raw, `${name}.png`));
    const out = join(outRoot, lang);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    console.log(`> ${lang}: rendering the store images`);
    for (const [i, s] of copy.screenshots.entries()) {
      const html = screenshotHtml({
        fonts,
        logo,
        copy: s,
        page: img(s.page),
        panel: img(s.panel),
        kind: s.kind,
        address: copy.address,
      });
      await render(browser, html, 1280, 800, join(out, `0${i + 1}-${s.slug}.png`));
    }
    await render(
      browser,
      promoHtml({ fonts, logo, copy: copy.promo, popup: img('popup-detect') }),
      440,
      280,
      join(out, 'promo-small.png'),
    );
    await render(
      browser,
      marqueeHtml({
        fonts,
        logo,
        copy: copy.marquee,
        page: img('page-demo'),
        popup: img('popup-detect'),
        address: copy.address,
      }),
      1400,
      560,
      join(out, 'marquee.png'),
    );
    // The website reuses the captures: a hero composite without words, and the UI itself for the feature rows.
    const site = join(out, 'site');
    mkdirSync(site, { recursive: true });
    await renderSiteArt(
      browser,
      heroHtml({ fonts, logo, page: img('page-demo'), popup: img('popup-detect'), address: copy.address }),
      1300,
      760,
      join(site, 'hero.png'),
    );
    for (const name of ['popup-detect', 'studio', 'popup-queue', 'popup-live', 'popup-members'])
      webp(join(raw, `${name}.png`), join(site, `${name}.webp`));
    webp(join(site, 'hero.png'), join(site, 'hero.webp'));
    rmSync(join(site, 'hero.png'));
  }
} finally {
  await browser.close();
  await servers.close();
}
console.log('> done');
process.exit(0);
