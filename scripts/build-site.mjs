// Builds the website into site/dist (deployed by .github/workflows/pages.yml):
//   index.html (English), it/index.html (Italian), assets/ (css, fonts, logo), shots/<lang>/ (store-assets/<lang>/...).
// The images come from `npm run store:assets` (committed in store-assets/), so building the site needs no browser.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { LANGS, checksLabel, missingKeys, renderPage } from './lib/site.ts';

const root = resolve(import.meta.dirname, '..');
const site = join(root, 'site');
const out = join(site, 'dist');
const read = (p) => readFileSync(p, 'utf8');

const config = JSON.parse(read(join(site, 'config.json')));
const template = read(join(site, 'template.html'));
const strings = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(join(site, 'i18n', `${l}.json`)))]));
const gap = missingKeys(strings.en, strings.it);
if (gap.length > 0) throw new Error(`site strings differ between en and it: ${gap.join(', ')}`);
const checks = checksLabel((read(join(root, 'e2e/run.mjs')).match(/^\s*await step\(/gm) ?? []).length);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets/fonts'), { recursive: true });
copyFileSync(join(site, 'site.css'), join(out, 'assets/site.css'));
copyFileSync(join(root, 'public/logo.svg'), join(out, 'assets/logo.svg'));
const nm = join(root, 'node_modules');
for (const f of [
  '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2',
])
  copyFileSync(join(nm, f), join(out, 'assets/fonts', f.split('/').pop()));

for (const lang of LANGS) {
  const shots = join(root, 'store-assets', lang);
  if (!existsSync(join(shots, 'site/hero.webp')))
    throw new Error(`missing ${lang} images: run npm run store:assets`);
  const dest = join(out, 'shots', lang);
  mkdirSync(dest, { recursive: true });
  cpSync(join(shots, 'site'), dest, { recursive: true });
  copyFileSync(join(shots, 'marquee.png'), join(dest, 'marquee.png'));
  const dir = lang === 'en' ? out : join(out, lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), renderPage(template, strings[lang], config, lang, checks));
}
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}sitemap.xml\n`);
writeFileSync(
  join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `<url><loc>${config.siteUrl}</loc></url>\n<url><loc>${config.siteUrl}it/</loc></url>\n</urlset>\n`,
);
console.log(
  `site built in ${out.slice(root.length + 1)}: ${readdirSync(out).join(', ')} (e2e checks: ${checks})`,
);
