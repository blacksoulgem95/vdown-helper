// The website's pages, built from one template and a string table per language (scripts/build-site.mjs writes them).
// Pure functions, so the rules are unit-tested: every placeholder must resolve, and both languages carry the same keys.

export type Strings = Record<string, string>;

export interface SiteConfig {
  storeUrl: string;
  downloadUrl: string;
  releasesUrl: string;
  repoUrl: string;
  siteUrl: string;
}

export const LANGS = ['en', 'it'] as const;
export type Lang = (typeof LANGS)[number];

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Keys present in one table and not the other (both directions), for the parity check. */
export function missingKeys(a: Strings, b: Strings): string[] {
  return [...Object.keys(a).filter((k) => !(k in b)), ...Object.keys(b).filter((k) => !(k in a))].sort();
}

/** Keep `<!--if:name-->…<!--endif:name-->` blocks whose flag is on, drop the others. */
export function applyBlocks(html: string, flags: Record<string, boolean>): string {
  return html.replace(/<!--if:([a-z]+)-->([\s\S]*?)<!--endif:\1-->/g, (_m, name: string, body: string) => {
    if (!(name in flags)) throw new Error(`unknown block ${name}`);
    return flags[name] ? body : '';
  });
}

/** "112" -> "110+": the count of end-to-end checks, rounded down so the page stays true as tests are added. */
export function checksLabel(count: number): string {
  return count >= 10 ? `${Math.floor(count / 10) * 10}+` : String(count);
}

export function renderPage(
  template: string,
  strings: Strings,
  config: SiteConfig,
  lang: Lang,
  checks: string,
): string {
  const en = lang === 'en';
  const root = en ? '' : '../';
  const store = config.storeUrl.trim() !== '';
  const vars: Record<string, string> = {
    lang,
    root,
    homePath: en ? '' : 'it/',
    shots: `${root}shots/${lang}/`,
    canonical: `${config.siteUrl}${en ? '' : 'it/'}`,
    siteUrl: config.siteUrl,
    switchHref: en ? 'it/' : '../',
    switchLang: en ? 'it' : 'en',
    // Until the store listing exists, the main button leads to the 3-step install, whose first step is the download.
    ctaHref: store ? config.storeUrl : '#install',
    ctaLabel: strings[store ? 'cta.store' : 'cta.download'] ?? '',
    storeUrl: config.storeUrl,
    downloadUrl: config.downloadUrl,
    releasesUrl: config.releasesUrl,
    repoUrl: config.repoUrl,
    checks,
  };
  const html = applyBlocks(template, { store, nostore: !store });
  return html.replace(/\{\{(t:)?([a-zA-Z0-9.]+)\}\}/g, (_m, isText: string | undefined, key: string) => {
    const value = isText ? strings[key] : vars[key];
    if (value === undefined) throw new Error(`${lang}: no value for {{${isText ?? ''}${key}}}`);
    return escapeHtml(value);
  });
}
