/**
 * Page metadata (content script). Everything here is a READ: tags and JSON-LD already in the page, and anonymous
 * requests to the page's OWN origin (a podcast feed it links to, the public API of the site the user is on), exactly as
 * a script of the page could. Nothing is interpreted here: the background parses what this reads (lib/metadata), so the
 * shared core never has to load in the page. Nothing is sent to any other server.
 */
import type { PageData } from '@/types/media';

const MAX_LD_SCRIPTS = 20;
const MAX_LD_CHARS = 256 * 1024;
const MAX_TAGS = 400;
const FETCH_MS = 3000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The document's own tags: Open Graph, Twitter, JSON-LD and <link rel>. */
export function collectPageData(doc: Document): PageData {
  const tags: PageData['tags'] = [];
  for (const m of doc.querySelectorAll('meta[content]')) {
    if (tags.length >= MAX_TAGS) break;
    const key = (m.getAttribute('property') ?? m.getAttribute('name') ?? '').trim().toLowerCase();
    const content = m.getAttribute('content');
    if (key && content) tags.push({ key, content });
  }
  const links: PageData['links'] = [];
  for (const l of doc.querySelectorAll('link[rel][href]')) {
    if (links.length >= MAX_TAGS) break;
    links.push({
      rel: l.getAttribute('rel') ?? '',
      type: l.getAttribute('type') ?? '',
      href: l.getAttribute('href') ?? '',
      ...(l.getAttribute('title') ? { title: l.getAttribute('title') as string } : {}),
    });
  }
  const ld: string[] = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    if (ld.length >= MAX_LD_SCRIPTS) break;
    const text = s.textContent ?? '';
    if (text && text.length <= MAX_LD_CHARS) ld.push(text);
  }
  return { base: doc.baseURI, tags, links, ld };
}

/** A text response from the page's own origin, anonymously, bounded in time and size. Undefined on any problem. */
export async function sameOriginText(url: string): Promise<string | undefined> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
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
