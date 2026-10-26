/**
 * Media that a page announces through public, standard metadata: Open Graph / Twitter tags, JSON-LD (schema.org
 * VideoObject and AudioObject), <link rel="alternate"> and podcast feeds (RSS enclosures, Atom). The page is hostile
 * input: everything is validated here, bounded, and returned as plain candidates; nothing is fetched or run.
 */
import { isSafeFetchUrl, parseUrl } from './security';
import { childrenNamed, firstChild, localName, parseXml } from './xml';
import { parseIsoDuration } from './dash/parser';

export interface MetaMedia {
  url: string;
  mimeType?: string;
  mediaType?: 'video' | 'audio';
  title?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  poster?: string;
}

export const MAX_META_ITEMS = 60;
const MAX_TEXT = 200;
const clip = (s: unknown): string | undefined =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, MAX_TEXT) : undefined;

/** An absolute http(s) address, or undefined (relative addresses are resolved against `base`). */
export function safeAbs(raw: unknown, base: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.trim()) return undefined;
  const u = parseUrl(raw.trim(), base);
  return u && isSafeFetchUrl(u.href) ? u.href : undefined;
}

/** 'video' or 'audio' from a MIME type; undefined for anything else (images, HTML players, flash). */
export function mediaTypeOfMime(mime: string | undefined): 'video' | 'audio' | undefined {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/vnd.apple.mpegurl' || m === 'application/x-mpegurl' || m === 'application/dash+xml')
    return 'video';
  return undefined;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

function finish(m: MetaMedia): MetaMedia {
  for (const k of Object.keys(m) as Array<keyof MetaMedia>) if (m[k] === undefined) delete m[k];
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Open Graph / Twitter

export interface MetaTag {
  /** property= or name= */
  key: string;
  content: string;
}

/**
 * og:video (+ :url, :secure_url, :type, :width, :height) and og:audio, twitter:player:stream. The type given for an
 * og:video is for the media at that address; a tag whose address is a web page (text/html, an embed player) is not a file.
 */
export function mediaFromMetaTags(tags: readonly MetaTag[], base: string): MetaMedia[] {
  const out: MetaMedia[] = [];
  const first = (key: string) => tags.find((t) => t.key === key)?.content;
  const title = clip(first('og:title')) ?? clip(first('twitter:title'));
  const poster = safeAbs(first('og:image') ?? first('twitter:image'), base);
  const seen = new Set<string>();
  const add = (
    url: string | undefined,
    kind: 'video' | 'audio',
    mime: string | undefined,
    extra: Partial<MetaMedia>,
  ) => {
    const abs = safeAbs(url, base);
    if (!abs || seen.has(abs) || out.length >= MAX_META_ITEMS) return;
    const type = (mime ?? '').split(';')[0]?.trim().toLowerCase();
    // an embed page is not media (the player inside it is found when its frame is scanned)
    if (type === 'text/html' || type === 'application/x-shockwave-flash') return;
    seen.add(abs);
    out.push(
      finish({
        url: abs,
        ...(type ? { mimeType: type } : {}),
        mediaType: mediaTypeOfMime(type) ?? kind,
        title,
        poster,
        ...extra,
      }),
    );
  };
  const w = num(first('og:video:width'));
  const h = num(first('og:video:height'));
  const size = w && h ? { width: w, height: h } : {};
  const vtype = first('og:video:type');
  for (const k of ['og:video', 'og:video:url', 'og:video:secure_url'])
    for (const t of tags) if (t.key === k) add(t.content, 'video', vtype, size);
  const atype = first('og:audio:type');
  for (const k of ['og:audio', 'og:audio:url', 'og:audio:secure_url'])
    for (const t of tags) if (t.key === k) add(t.content, 'audio', atype, {});
  const stream = first('twitter:player:stream');
  if (stream) add(stream, 'video', first('twitter:player:stream:content_type'), size);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-LD

const LD_TYPES = new Set(['VideoObject', 'AudioObject', 'MusicRecording', 'Clip']);

function ldTypes(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
}

function* walkLd(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 100)) yield* walkLd(v, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  yield node;
  for (const key of ['@graph', 'video', 'audio', 'mainEntity', 'hasPart', 'associatedMedia', 'subjectOf'])
    if (key in node) yield* walkLd(node[key], depth + 1);
}

/** `contentUrl` of VideoObject / AudioObject nodes. `embedUrl` is a web page and is deliberately ignored. */
export function mediaFromJsonLd(text: string, base: string): MetaMedia[] {
  if (text.length > 1_000_000) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: MetaMedia[] = [];
  for (const node of walkLd(data)) {
    const types = ldTypes(node);
    if (!types.some((t) => LD_TYPES.has(t))) continue;
    const urls = Array.isArray(node['contentUrl']) ? node['contentUrl'] : [node['contentUrl']];
    for (const raw of urls.slice(0, 10)) {
      const url = safeAbs(raw, base);
      if (!url || out.some((o) => o.url === url) || out.length >= MAX_META_ITEMS) continue;
      const format = typeof node['encodingFormat'] === 'string' ? node['encodingFormat'] : undefined;
      const thumb = Array.isArray(node['thumbnailUrl']) ? node['thumbnailUrl'][0] : node['thumbnailUrl'];
      out.push(
        finish({
          url,
          mimeType: format?.toLowerCase().slice(0, 100),
          mediaType: mediaTypeOfMime(format) ?? (types.includes('VideoObject') ? 'video' : 'audio'),
          title: clip(node['name']),
          durationSec: typeof node['duration'] === 'string' ? parseIsoDuration(node['duration']) : undefined,
          width: num(node['width']),
          height: num(node['height']),
          poster: safeAbs(thumb, base),
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// <link rel="alternate">

export interface LinkTag {
  rel: string;
  type: string;
  href: string;
  title?: string;
}

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml']);

/** Alternate representations of the page that are media files themselves, and the feeds the page offers. */
export function mediaFromLinks(
  links: readonly LinkTag[],
  base: string,
): { media: MetaMedia[]; feeds: string[] } {
  const media: MetaMedia[] = [];
  const feeds: string[] = [];
  for (const l of links) {
    if (!/(^|\s)alternate(\s|$)/i.test(l.rel)) continue;
    const type = l.type.split(';')[0]?.trim().toLowerCase() ?? '';
    const url = safeAbs(l.href, base);
    if (!url) continue;
    if (FEED_TYPES.has(type)) {
      if (feeds.length < 3) feeds.push(url);
    } else if (mediaTypeOfMime(type) && media.length < MAX_META_ITEMS) {
      media.push(finish({ url, mimeType: type, mediaType: mediaTypeOfMime(type), title: clip(l.title) }));
    }
  }
  return { media, feeds };
}

// ---------------------------------------------------------------------------------------------------------------
// Podcast feeds

const AUDIO_VIDEO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|mp4|m4v|webm|mov|ogv)(?:$|[?#])/i;

/** RSS `<enclosure>` and Atom `<link rel="enclosure">` entries that are audio or video. */
export function mediaFromFeed(text: string, base: string): MetaMedia[] {
  if (text.length > 2_000_000) return [];
  const root = parseXml(text);
  if (!root) return [];
  const out: MetaMedia[] = [];
  const consider = (
    url: string | undefined,
    type: string | undefined,
    title: string | undefined,
    dur?: number,
  ) => {
    const abs = safeAbs(url, base);
    const mime = type?.split(';')[0]?.trim().toLowerCase() || undefined;
    if (!abs || out.length >= MAX_META_ITEMS || out.some((o) => o.url === abs)) return;
    const kind =
      mediaTypeOfMime(mime) ??
      (AUDIO_VIDEO_EXT.test(abs)
        ? /\.(mp4|m4v|webm|mov|ogv)(?:$|[?#])/i.test(abs)
          ? 'video'
          : 'audio'
        : undefined);
    if (!kind) return;
    out.push(finish({ url: abs, mimeType: mime, mediaType: kind, title: clip(title), durationSec: dur }));
  };
  const channel = firstChild(root, 'channel');
  for (const item of channel ? childrenNamed(channel, 'item') : []) {
    const title = firstChild(item, 'title')?.text;
    const dur = item.children.find((c) => localName(c.name).toLowerCase() === 'duration')?.text.trim();
    const sec = dur ? (/^\d+$/.test(dur) ? Number(dur) : clockSeconds(dur)) : undefined;
    for (const enc of childrenNamed(item, 'enclosure'))
      consider(enc.attrs['url'], enc.attrs['type'], title, sec);
  }
  for (const entry of childrenNamed(root, 'entry')) {
    const title = firstChild(entry, 'title')?.text;
    for (const l of childrenNamed(entry, 'link'))
      if ((l.attrs['rel'] ?? '').toLowerCase() === 'enclosure')
        consider(l.attrs['href'], l.attrs['type'], title);
  }
  return out;
}

function clockSeconds(s: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}
