import type { MetaMedia } from '../metadata';
import { mediaTypeOfMime, safeAbs } from '../metadata';
import type { SiteLookup } from './types';

/** Wikimedia Commons (and the Wikipedias, which show the same files): `/wiki/File:Name.webm`. */
const HOST = /^(commons\.wikimedia\.org|[a-z-]{2,12}\.(wikipedia|wikibooks|wikiversity|wikisource)\.org)$/;

export function commonsLookup(page: URL): SiteLookup | undefined {
  if (page.protocol !== 'https:' || !HOST.test(page.hostname)) return undefined;
  const m = /^\/wiki\/(File:[^?#]+)$/.exec(page.pathname);
  if (!m) return undefined;
  let title: string;
  try {
    title = decodeURIComponent(m[1] as string).replace(/_/g, ' ');
  } catch {
    return undefined;
  }
  const api = new URL('/w/api.php', page.origin);
  api.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'videoinfo',
    viprop: 'url|mime|size|mediatype|duration|derivatives|extmetadata',
    titles: title,
  }).toString();
  return { site: 'commons', apiUrl: api.href, parse: (json) => parseCommons(json, page.href) };
}

interface Rec {
  [k: string]: unknown;
}
const rec = (v: unknown): Rec | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;

/** The original file, and the transcodes MediaWiki made of it (they play everywhere; the original may be Ogg/WebM only). */
export function parseCommons(json: unknown, base: string): MetaMedia[] {
  const pages = rec(rec(rec(json)?.['query']))?.['pages'];
  const page = Array.isArray(pages) ? rec(pages[0]) : undefined;
  const infos = page?.['videoinfo'] ?? page?.['imageinfo'];
  const info = Array.isArray(infos) ? rec(infos[0]) : undefined;
  if (!info) return [];
  const kind = String(info['mediatype'] ?? '').toUpperCase();
  if (kind !== 'VIDEO' && kind !== 'AUDIO') return [];
  const ext = rec(info['extmetadata']);
  const name = rec(ext?.['ObjectName'])?.['value'];
  const title =
    typeof name === 'string' && name.trim()
      ? name.trim().slice(0, 200)
      : String(page?.['title'] ?? '')
          .replace(/^File:/, '')
          .slice(0, 200);
  const duration = typeof info['duration'] === 'number' ? info['duration'] : undefined;
  const out: MetaMedia[] = [];
  const mediaType = kind === 'VIDEO' ? 'video' : 'audio';
  const orig = safeAbs(info['url'], base);
  const origMime =
    typeof info['mime'] === 'string' ? info['mime'].split(';')[0]!.trim().toLowerCase() : undefined;
  if (orig)
    out.push({
      url: orig,
      mediaType: mediaTypeOfMime(origMime) ?? mediaType,
      title,
      ...(origMime ? { mimeType: origMime } : {}),
      ...(duration ? { durationSec: duration } : {}),
      ...(typeof info['width'] === 'number' ? { width: info['width'] } : {}),
      ...(typeof info['height'] === 'number' ? { height: info['height'] } : {}),
    });
  const derivatives = Array.isArray(info['derivatives']) ? info['derivatives'] : [];
  for (const d of derivatives.slice(0, 20)) {
    const r = rec(d);
    const url = safeAbs(r?.['src'] ?? r?.['url'], base); // `src` is protocol-relative ("//upload.wikimedia.org/...")
    if (!url || url === orig) continue;
    const mime = typeof r?.['type'] === 'string' ? r['type'].split(';')[0]!.trim().toLowerCase() : undefined;
    const label =
      typeof r?.['shorttitle'] === 'string'
        ? r['shorttitle']
        : typeof r?.['title'] === 'string'
          ? r['title']
          : '';
    out.push({
      url,
      mediaType: mediaTypeOfMime(mime) ?? mediaType,
      title: `${title}${label ? ` (${label.slice(0, 40)})` : ''}`,
      ...(mime ? { mimeType: mime } : {}),
      ...(duration ? { durationSec: duration } : {}),
      ...(typeof r?.['width'] === 'number' ? { width: r['width'] } : {}),
      ...(typeof r?.['height'] === 'number' ? { height: r['height'] } : {}),
    });
  }
  return out;
}
