/**
 * Page metadata and open-site lookups (content script). Everything here is a READ: tags and JSON-LD already in the
 * page, and requests to the page's OWN origin (a podcast feed it links to, the public API of the site the user is on)
 * made anonymously, exactly as a script of the page could. Nothing is sent to any other server.
 */
import {
  mediaFromFeed,
  mediaFromJsonLd,
  mediaFromLinks,
  mediaFromMetaTags,
  type LinkTag,
  type MetaMedia,
  type MetaTag,
} from '@/lib/metadata';
import { siteLookupFor } from '@/lib/sites';

const MAX_LD_SCRIPTS = 20;
const MAX_TAGS = 400;
const FETCH_MS = 3000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface CollectedMetadata {
  media: MetaMedia[];
  /** Feed addresses the page offers (<link rel="alternate" type="application/rss+xml">). */
  feeds: string[];
}

/** Media announced by the document's own tags: Open Graph, Twitter, JSON-LD and <link rel="alternate">. */
export function collectMetadata(doc: Document): CollectedMetadata {
  const base = doc.baseURI;
  const tags: MetaTag[] = [];
  for (const m of doc.querySelectorAll('meta[content]')) {
    if (tags.length >= MAX_TAGS) break;
    const key = (m.getAttribute('property') ?? m.getAttribute('name') ?? '').trim().toLowerCase();
    const content = m.getAttribute('content');
    if (key && content) tags.push({ key, content });
  }
  const links: LinkTag[] = [];
  for (const l of doc.querySelectorAll('link[rel][href]')) {
    if (links.length >= MAX_TAGS) break;
    links.push({
      rel: l.getAttribute('rel') ?? '',
      type: l.getAttribute('type') ?? '',
      href: l.getAttribute('href') ?? '',
      ...(l.getAttribute('title') ? { title: l.getAttribute('title') as string } : {}),
    });
  }
  const media = mediaFromMetaTags(tags, base);
  let ld = 0;
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    if (++ld > MAX_LD_SCRIPTS) break;
    media.push(...mediaFromJsonLd(s.textContent ?? '', base));
  }
  const fromLinks = mediaFromLinks(links, base);
  media.push(...fromLinks.media);
  return { media, feeds: fromLinks.feeds };
}

/** A text response from the page's own origin, anonymously, bounded in time and size. Undefined on any problem. */
async function sameOriginText(url: string): Promise<string | undefined> {
  const target = new URL(url);
  if (target.origin !== location.origin) return undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(target.href, { credentials: 'omit', redirect: 'follow', signal: ctl.signal });
    if (!res.ok || new URL(res.url || target.href).origin !== location.origin) return undefined;
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return undefined;
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        ctl.abort();
        return undefined;
      }
      parts.push(step.value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    return new TextDecoder().decode(all);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Media a known open site lists for the page the user is on (Wikimedia Commons, Internet Archive, PeerTube). */
export async function siteMedia(page: URL = new URL(location.href)): Promise<MetaMedia[]> {
  const lookup = siteLookupFor(page);
  if (!lookup) return [];
  const text = await sameOriginText(lookup.apiUrl);
  if (text === undefined) return [];
  try {
    return lookup.parse(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Audio and video enclosures of the feeds the page offers (only feeds on the page's own origin are read). */
export async function feedMedia(feeds: readonly string[]): Promise<MetaMedia[]> {
  const out: MetaMedia[] = [];
  for (const feed of feeds.slice(0, 2)) {
    const text = await sameOriginText(feed);
    if (text !== undefined) out.push(...mediaFromFeed(text, feed));
  }
  return out;
}
