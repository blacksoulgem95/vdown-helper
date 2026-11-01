import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBlocks,
  checksLabel,
  missingKeys,
  renderPage,
  type DesktopAssets,
  type SiteConfig,
} from '../scripts/lib/site.ts';

const root = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strings = {
  en: JSON.parse(read('site/i18n/en.json')) as Record<string, string>,
  it: JSON.parse(read('site/i18n/it.json')) as Record<string, string>,
};
const template = read('site/template.html');
const config = JSON.parse(read('site/config.json')) as SiteConfig;
const desktop = JSON.parse(read('desktop/release-assets.json')) as DesktopAssets;
type Shot = { kind: string; page: string; panel: string };
const COPY = JSON.parse(read('store/copy.json')) as Record<'en' | 'it', { screenshots: Shot[] }>;

describe('website (VDH-052)', () => {
  it('English and Italian carry the same keys, none empty', () => {
    expect(missingKeys(strings.en, strings.it)).toEqual([]);
    for (const table of Object.values(strings))
      for (const v of Object.values(table)) expect(v.trim()).not.toBe('');
  });
  it('every placeholder resolves in both languages, and nothing is left unreplaced', () => {
    for (const lang of ['en', 'it'] as const) {
      const html = renderPage(template, strings[lang], config, lang, '110+', desktop);
      expect(html).not.toMatch(/\{\{|\}\}|<!--if:|<!--endif:/);
      expect(html).toContain(`<html lang="${lang}">`);
    }
  });
  it('without a store listing, the main button leads to the 3-step install; with one, to the store', () => {
    const soon = renderPage(template, strings.en, { ...config, storeUrl: '' }, 'en', '110+', desktop);
    expect(soon).toContain('href="#install"');
    expect(soon).toContain(config.downloadUrl);
    expect(soon).not.toContain('Add it from the Chrome Web Store');
    const store = 'https://chromewebstore.google.com/detail/example';
    const live = renderPage(template, strings.en, { ...config, storeUrl: store }, 'en', '110+', desktop);
    expect(live).toContain(`href="${store}"`);
    expect(live).toContain('Add to Chrome');
    expect(live).not.toContain('coming soon');
  });
  it('links every desktop installer under the fixed name the release workflow gives it (VDH-086)', () => {
    const html = renderPage(template, strings.it, config, 'it', '110+', desktop);
    const files = Object.values(desktop).map((a) => a.file);
    expect(files).toHaveLength(8);
    for (const file of files)
      expect(html).toContain(
        `href="https://github.com/blacksoulgem95/vdown-helper/releases/latest/download/${file}"`,
      );
    // one installer per target and kind, as scripts/desktop/smoke-test.mjs looks them up
    const pairs = Object.values(desktop).map((a) => `${a.target}/${a.kind}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(html).toContain('id="desktop"');
  });
  it('loads nothing from other sites: every src and stylesheet is local', () => {
    const html = renderPage(template, strings.it, config, 'it', '110+', desktop);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1] as string;
      if (/<link rel="stylesheet"|<img|<script/.test(html.slice(Math.max(0, (m.index ?? 0) - 40), m.index)))
        expect(url).not.toMatch(/^https?:/);
    }
    expect(html).not.toMatch(/<script/);
  });
  it('escapes text, keeps known blocks and refuses unknown ones', () => {
    expect(renderPage('<p>{{t:x}}</p>', { x: '<b>&' }, config, 'en', '1', desktop)).toBe(
      '<p>&lt;b&gt;&amp;</p>',
    );
    expect(
      applyBlocks('a<!--if:on-->B<!--endif:on--><!--if:off-->C<!--endif:off-->', { on: true, off: false }),
    ).toBe('aB');
    expect(() => applyBlocks('<!--if:x-->y<!--endif:x-->', {})).toThrow();
    expect(() => renderPage('{{t:nope}}', {}, config, 'en', '1', desktop)).toThrow(/nope/);
  });
  it('rounds the number of end-to-end checks down', () => {
    expect(checksLabel(117)).toBe('110+');
    expect(checksLabel(7)).toBe('7');
  });
  it('the store images have the same five screenshots in both languages', () => {
    expect(COPY.en.screenshots.map((s) => [s.kind, s.page, s.panel])).toEqual(
      COPY.it.screenshots.map((s) => [s.kind, s.page, s.panel]),
    );
    expect(COPY.en.screenshots).toHaveLength(5); // the store accepts at most 5
  });
});
