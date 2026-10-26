/**
 * Content script (classic IIFE), injected on demand with chrome.scripting.executeScript after a user action.
 * It only READS the page: it never modifies the DOM, never sends data anywhere, and exposes a small API on
 * an isolated-world global that the extension then calls with executeScript({ func }).
 *
 * Fetches made here use the page's origin and cookies, exactly like the page's own player, so no extra host
 * permission is needed to read media the page itself can read.
 */
import { fetchText, probeHeaders } from '@/lib/netprobe';
import type { DetectionMethod, RawCandidate, ScanReport } from '@/types/media';

const MEDIA_EXT =
  /\.(mp4|m4v|webm|mkv|mov|ogv|ts|mp3|m4a|aac|wav|ogg|oga|opus|flac|m3u8|m3u|mpd|vtt|srt|ttml|dfxp)(?:$|[?#])/i;
const MAX_CANDIDATES = 200;
const MAX_BLOCKED_FRAMES = 20;

function abs(url: string | null | undefined, base: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, base).toString();
  } catch {
    return undefined;
  }
}

function httpOrigin(raw: string | null | undefined, base: string): string | undefined {
  const url = abs(raw, base);
  return url && /^https?:/i.test(url) ? new URL(url).origin : undefined;
}

function* roots(doc: Document): Generator<Document | ShadowRoot> {
  yield doc;
  // Open shadow roots only; closed roots are intentionally not reachable.
  const stack: Array<Document | ShadowRoot> = [doc];
  while (stack.length) {
    const root = stack.pop();
    if (!root) break;
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (el.shadowRoot) {
        stack.push(el.shadowRoot);
        yield el.shadowRoot;
      }
    }
  }
}

interface Collector {
  candidates: RawCandidate[];
  notes: ScanReport['notes'];
  seen: Set<string>;
}

function add(c: Collector, candidate: RawCandidate): void {
  if (c.candidates.length >= MAX_CANDIDATES) return;
  const key = `${candidate.url}|${candidate.method}`;
  if (c.seen.has(key)) return;
  c.seen.add(key);
  c.candidates.push(candidate);
}

function addUrl(
  c: Collector,
  raw: string | null | undefined,
  base: string,
  method: DetectionMethod,
  extra: Partial<RawCandidate> = {},
): void {
  const url = abs(raw, base);
  if (!url) return;
  if (url.startsWith('blob:')) {
    c.notes.blobSources++;
    return;
  }
  if (!/^https?:/i.test(url)) return; // data:, javascript:, etc. are never candidates
  add(c, { url, method, ...extra });
}

function scanElements(c: Collector, doc: Document): void {
  const base = doc.baseURI;
  for (const root of roots(doc)) {
    for (const media of root.querySelectorAll<HTMLMediaElement>('video, audio')) {
      const isVideo = media instanceof HTMLVideoElement;
      const extra: Partial<RawCandidate> = { mediaType: isVideo ? 'video' : 'audio' };
      if (Number.isFinite(media.duration) && media.duration > 0) extra.durationSec = media.duration;
      if (isVideo && media.videoWidth > 0) {
        extra.width = media.videoWidth;
        extra.height = media.videoHeight;
      }
      const title = media.getAttribute('title') ?? media.getAttribute('aria-label') ?? undefined;
      if (title) extra.title = title.slice(0, 300);
      if (isVideo && media.poster) {
        const poster = abs(media.poster, base);
        if (poster && /^https?:/i.test(poster)) extra.poster = poster;
      }
      for (const track of media.querySelectorAll('track')) {
        const kind = (track.getAttribute('kind') ?? 'subtitles').toLowerCase();
        if (kind !== 'subtitles' && kind !== 'captions') continue; // chapters, descriptions and metadata are not subtitles
        const lang = track.getAttribute('srclang')?.slice(0, 35);
        const label = track.getAttribute('label')?.slice(0, 100);
        addUrl(c, track.getAttribute('src'), base, 'dom-track', {
          role: 'subtitle',
          mimeType: 'text/vtt', // the HTML spec: <track> sources are WebVTT
          ...(lang ? { language: lang } : {}),
          ...(label ? { title: label } : {}),
        });
      }
      addUrl(c, media.currentSrc, base, 'dom-element', extra);
      addUrl(c, media.getAttribute('src'), base, 'dom-element', extra);
      for (const s of media.querySelectorAll('source')) {
        const type = s.getAttribute('type') ?? undefined;
        addUrl(c, s.getAttribute('src'), base, 'dom-source', type ? { ...extra, mimeType: type } : extra);
      }
    }
    // Standalone <source> not inside media elements (e.g. inside <picture> is irrelevant; keep only media-looking ones).
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.getAttribute('href');
      if (href && MEDIA_EXT.test(href))
        addUrl(
          c,
          href,
          base,
          'dom-link',
          a.textContent?.trim() ? { title: a.textContent.trim().slice(0, 200) } : {},
        );
    }
  }
}

function scanPerformance(c: Collector, base: string): void {
  let entries: PerformanceEntry[];
  try {
    entries = performance.getEntriesByType('resource');
  } catch {
    return;
  }
  for (const e of entries) {
    const r = e as PerformanceResourceTiming;
    const isMediaType = r.initiatorType === 'video' || r.initiatorType === 'audio';
    if (isMediaType || MEDIA_EXT.test(r.name)) addUrl(c, r.name, base, 'performance');
  }
}

export function scan(): ScanReport {
  const c: Collector = {
    candidates: [],
    notes: { blobSources: 0, inaccessibleFrames: 0, blockedFrameOrigins: [] },
    seen: new Set(),
  };
  const doc = document;
  scanElements(c, doc);
  // Same-origin iframes are readable here; every frame is also scanned by its own copy of this script (allFrames).
  // Frames this script cannot read are reported by origin so the user can allow them.
  const blocked = new Set<string>();
  for (const frame of doc.querySelectorAll('iframe')) {
    try {
      const inner = frame.contentDocument;
      if (inner) {
        scanElements(c, inner);
        continue;
      }
    } catch {
      // cross-origin: fall through
    }
    c.notes.inaccessibleFrames++;
    const origin = httpOrigin(frame.getAttribute('src'), doc.baseURI);
    if (origin && origin !== location.origin && blocked.size < MAX_BLOCKED_FRAMES) blocked.add(origin);
  }
  c.notes.blockedFrameOrigins = [...blocked];
  scanPerformance(c, doc.baseURI);
  return {
    pageUrl: location.href,
    pageTitle: document.title.slice(0, 300),
    candidates: c.candidates,
    notes: c.notes,
  };
}

export interface VdhApi {
  scan: typeof scan;
  probeHeaders: (url: string) => ReturnType<typeof probeHeaders>;
  fetchText: (url: string) => ReturnType<typeof fetchText>;
}

const api: VdhApi = {
  scan,
  probeHeaders: (url) => probeHeaders(url),
  fetchText: (url) => fetchText(url),
};
(globalThis as unknown as { __vdh?: VdhApi }).__vdh = api;
