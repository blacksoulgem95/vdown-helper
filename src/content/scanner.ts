/**
 * Content script (classic IIFE), injected on demand with chrome.scripting.executeScript after a user action.
 * It only READS the page: it never modifies the DOM, never sends data anywhere, and exposes a small API on
 * an isolated-world global that the extension then calls with executeScript({ func }).
 *
 * Fetches made here use the page's origin and cookies, exactly like the page's own player, so no extra host
 * permission is needed to read media the page itself can read.
 */
import { blobLabel, dataHandle, dataLabel, inspectDataUrl } from '@/lib/dataUrl';
import { fileKindOfExtension, fileKindOfMime, urlExtension, type FileKind } from '@/lib/filetypes';
import { sniffMime } from '@/lib/sniff';
import { HELD_BLOB_LIMIT } from '@/types/ingest';
import { fetchText, probeHeaders } from '@/lib/netprobe';
import {
  describeStream,
  finishRecording,
  mseVideos,
  startCapture,
  startRecord as startStreamRecording,
  stopCapture,
  streamMedia,
  type BannerLabels,
  type CaptureResult,
  type RecordOptions,
  type RecordResult,
} from './capture';
import { pumpBlob, pumpData, type PumpResult } from './ingest';
import { collectMetadata, feedMedia, siteMedia } from './metadata';
import type { MetaMedia } from '@/lib/metadata';
import type { DetectionMethod, RawCandidate, ScanReport } from '@/types/media';

const MEDIA_EXT =
  /\.(mp4|m4v|webm|mkv|mov|ogv|ts|mp3|m4a|aac|wav|ogg|oga|opus|flac|aif|aiff|aifc|wma|flv|avi|wmv|asf|3gp|3g2|mpg|mpeg|mpe|m3u8|m3u|mpd|vtt|srt|ttml|dfxp)(?:$|[?#])/i;
/** Per kind, so a page with hundreds of images cannot crowd out its one video. */
const CAPS = { media: 200, image: 300, document: 100, archive: 100, asset: 200 } as const;
const MAX_HELD = 40;
const MAX_STYLE_ELEMENTS = 1500;
/** data: images smaller than this are icons and sprites, not worth listing. */
const MIN_HELD_IMAGE_BYTES = 2048;

/** data: URLs found by the last scan, by handle. They stay in the page; only a label leaves it (see ingest.ts). */
export const heldData = new Map<string, string>();
/**
 * Blobs the page holds, by handle. The Blob object itself is kept (not just its URL), so a page that revokes the URL
 * right after use cannot take the data away from a download that was already offered. Replaced on every scan.
 */
export const heldBlobs = new Map<string, Blob>();

interface PendingBlob {
  url: string;
  method: DetectionMethod;
  extra: Partial<RawCandidate>;
  /** Already counted in `notes.blobSources` (media sources are; images are not). */
  counted: boolean;
  /** The media element that uses it: if the blob cannot be read it is most likely a MediaSource (see capture.ts). */
  el?: HTMLMediaElement;
}
/** blob: sources the last synchronous scan met; scanAsync() reads them. */
let pendingBlobs: PendingBlob[] = [];
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
  counts: Record<keyof typeof CAPS, number>;
  blobUrls: Set<string>;
}

function add(c: Collector, candidate: RawCandidate): void {
  const bucket = candidate.fileKind ?? 'media';
  if (c.counts[bucket] >= CAPS[bucket]) return;
  const key = `${candidate.url}|${candidate.method}`;
  if (c.seen.has(key)) return;
  c.seen.add(key);
  c.counts[bucket]++;
  c.candidates.push(candidate);
}

/** A data: media source: report a small label and its size, keep the data here. */
function addData(c: Collector, raw: string, method: DetectionMethod, extra: Partial<RawCandidate>): void {
  const info = inspectDataUrl(raw);
  if (!info || !/^(video|audio|image)\//.test(info.mime) || heldData.size >= MAX_HELD) return;
  const isImage = info.mime.startsWith('image/');
  if (isImage && info.bytes < MIN_HELD_IMAGE_BYTES) return;
  const id = dataHandle(raw);
  if (!heldData.has(id)) heldData.set(id, raw);
  add(c, {
    ...extra,
    url: dataLabel(info.mime, id),
    method,
    mimeType: info.mime,
    held: { kind: 'data', id, bytes: info.bytes },
    ...(isImage ? { fileKind: 'image' as const } : {}),
  });
}

function addUrl(
  c: Collector,
  raw: string | null | undefined,
  base: string,
  method: DetectionMethod,
  extra: Partial<RawCandidate> = {},
  el?: HTMLMediaElement,
): void {
  if (raw && /^data:/i.test(raw)) {
    addData(c, raw, method, extra);
    return;
  }
  const url = abs(raw, base);
  if (!url) return;
  if (url.startsWith('blob:')) {
    // counted (once per distinct URL) as unreadable until scanAsync() manages to read it
    if (!c.blobUrls.has(url)) {
      c.blobUrls.add(url);
      c.notes.blobSources++;
    }
    if (pendingBlobs.length < MAX_HELD)
      pendingBlobs.push({ url, method, extra, counted: true, ...(el ? { el } : {}) });
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
      const stream = describeStream(media);
      if (stream) {
        // A camera, screen share, WebRTC or canvas stream: no address, but it can be recorded while it plays.
        streamMedia.set(stream.handle, media);
        add(c, {
          ...extra,
          mediaType: stream.hasVideo ? 'video' : 'audio',
          ...(stream.width && stream.height ? { width: stream.width, height: stream.height } : {}),
          url: dataLabel('application/x-vdh-stream', stream.handle),
          method: 'dom-element',
          held: { kind: 'stream', id: stream.handle, bytes: 0 },
        });
      }
      addUrl(c, media.currentSrc, base, 'dom-element', extra, media);
      addUrl(c, media.getAttribute('src'), base, 'dom-element', extra, media);
      for (const s of media.querySelectorAll('source')) {
        const type = s.getAttribute('type') ?? undefined;
        addUrl(c, s.getAttribute('src'), base, 'dom-source', type ? { ...extra, mimeType: type } : extra);
      }
    }
    // Standalone <source> not inside media elements (e.g. inside <picture> is irrelevant; keep only media-looking ones).
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.getAttribute('href');
      if (href && (MEDIA_EXT.test(href) || /^data:(video|audio)\//i.test(href) || /^blob:/i.test(href)))
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

/** A plain file (image, document, archive, page asset). data: images go through the held-bytes channel. */
function addFile(
  c: Collector,
  raw: string | null | undefined,
  base: string,
  method: DetectionMethod,
  kind: FileKind,
  extra: Partial<RawCandidate> = {},
): void {
  if (!raw) return;
  if (/^data:/i.test(raw)) {
    if (kind === 'image') addData(c, raw, method, extra);
    return;
  }
  if (/^(javascript|about):/i.test(raw)) return;
  const url = abs(raw, base);
  if (url?.startsWith('blob:')) {
    // an image the page holds as a blob: readable by scanAsync(), not counted as an unreadable media source
    if (pendingBlobs.length < MAX_HELD) pendingBlobs.push({ url, method, extra, counted: false });
    return;
  }
  if (!url || !/^https?:/i.test(url)) return;
  add(c, { url, method, fileKind: kind, ...extra });
}

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

/** Images, documents, archives and page assets referenced by the document. Read-only, bounded. */
function scanFiles(c: Collector, doc: Document): void {
  const base = doc.baseURI;
  for (const root of roots(doc)) {
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
      const extra: Partial<RawCandidate> = {};
      if (img.naturalWidth > 0) {
        extra.width = img.naturalWidth;
        extra.height = img.naturalHeight;
      }
      addFile(c, img.currentSrc || img.getAttribute('src'), base, 'dom-image', 'image', extra);
    }
    for (const v of root.querySelectorAll<HTMLVideoElement>('video[poster]'))
      addFile(c, v.getAttribute('poster'), base, 'dom-image', 'image');
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.getAttribute('href');
      if (!href || /^(data|javascript|blob|mailto|tel):/i.test(href)) continue;
      const abs0 = abs(href, base);
      const kind = abs0 ? fileKindOfExtension(urlExtension(abs0)) : undefined;
      // Assets are not links people follow; documents and archives are.
      if (kind === 'document' || kind === 'archive') addFile(c, abs0, base, 'dom-link', kind);
    }
    for (const s of root.querySelectorAll('script[src]'))
      addFile(c, s.getAttribute('src'), base, 'dom-element', 'asset');
    for (const l of root.querySelectorAll(
      'link[rel~="stylesheet"][href], link[rel="preload"][as="font"][href]',
    ))
      addFile(c, l.getAttribute('href'), base, 'dom-element', 'asset');
    if (root === doc) {
      for (const l of root.querySelectorAll('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]'))
        addFile(c, l.getAttribute('href'), base, 'dom-meta', 'image');
      for (const m of root.querySelectorAll(
        'meta[property="og:image"][content], meta[name="twitter:image"][content]',
      ))
        addFile(c, m.getAttribute('content'), base, 'dom-meta', 'image');
    }
    // CSS background images: computed style, bounded to the first elements of the document.
    let looked = 0;
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (++looked > MAX_STYLE_ELEMENTS) break;
      let bg: string;
      try {
        bg = getComputedStyle(el).backgroundImage;
      } catch {
        continue;
      }
      if (!bg || bg === 'none') continue;
      for (const m of bg.matchAll(CSS_URL)) addFile(c, m[2], base, 'dom-style', 'image');
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
    if (isMediaType || MEDIA_EXT.test(r.name)) {
      addUrl(c, r.name, base, 'performance');
      continue;
    }
    const kind =
      fileKindOfExtension(urlExtension(r.name)) ?? (r.initiatorType === 'img' ? 'image' : undefined);
    // encodedBodySize is 0 for cross-origin responses that do not allow timing: then the size is simply unknown.
    if (kind)
      addFile(
        c,
        r.name,
        base,
        'performance',
        kind,
        r.encodedBodySize > 0 ? { sizeBytes: r.encodedBodySize } : {},
      );
  }
}

/** Feeds the last scan's page offered; read (same origin only) by scanAsync(). */
let pendingFeeds: string[] = [];

/** A media address announced by metadata or an open site's API, as a candidate. */
function metaCandidate(m: MetaMedia, method: 'metadata' | 'site-api'): RawCandidate {
  return {
    url: m.url,
    method,
    ...(m.title ? { title: m.title } : {}),
    ...(m.mimeType ? { mimeType: m.mimeType } : {}),
    ...(m.mediaType ? { mediaType: m.mediaType } : {}),
    ...(m.durationSec ? { durationSec: m.durationSec } : {}),
    ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
    ...(m.poster ? { poster: m.poster } : {}),
  };
}

export function scan(): ScanReport {
  heldData.clear();
  streamMedia.clear();
  pendingBlobs = [];
  const c: Collector = {
    candidates: [],
    notes: { blobSources: 0, inaccessibleFrames: 0, blockedFrameOrigins: [] },
    seen: new Set(),
    counts: { media: 0, image: 0, document: 0, archive: 0, asset: 0 },
    blobUrls: new Set(),
  };
  const doc = document;
  scanElements(c, doc);
  scanFiles(c, doc);
  const meta = collectMetadata(doc);
  pendingFeeds = meta.feeds;
  for (const m of meta.media) add(c, metaCandidate(m, 'metadata'));
  // Same-origin iframes are readable here; every frame is also scanned by its own copy of this script (allFrames).
  // Frames this script cannot read are reported by origin so the user can allow them.
  const blocked = new Set<string>();
  for (const frame of doc.querySelectorAll('iframe')) {
    try {
      const inner = frame.contentDocument;
      if (inner) {
        scanElements(c, inner);
        scanFiles(c, inner);
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

const BLOB_PROBE_MS = 2500;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** Read what a blob: URL holds: its Blob, and its type (declared, or recognised from the first bytes). */
async function probeBlob(url: string): Promise<{ blob: Blob; mime: string } | undefined> {
  try {
    const blob = await withTimeout(
      fetch(url).then((r) => r.blob()),
      BLOB_PROBE_MS,
    );
    let mime = blob.type.split(';')[0]?.trim().toLowerCase() ?? '';
    // An untyped Blob is served by fetch() as "text/plain" in Chrome, so that type says nothing either: look at the bytes.
    if (
      !mime ||
      mime === 'application/octet-stream' ||
      mime === 'binary/octet-stream' ||
      mime === 'text/plain'
    ) {
      mime = sniffMime(new Uint8Array(await blob.slice(0, 600).arrayBuffer())) ?? mime;
    }
    return mime ? { blob, mime } : undefined;
  } catch {
    // a MediaSource URL, a revoked URL or a blob from another origin: not readable from here
    return undefined;
  }
}

/**
 * scan() plus the blob: sources it met. A blob the page can hand over is listed like any file, with its real size;
 * one that cannot be read (a MediaSource, a revoked URL) stays counted in `notes.blobSources`.
 */
export async function scanAsync(): Promise<ScanReport> {
  heldBlobs.clear();
  mseVideos.clear();
  const report = scan();
  // Open sites and the page's own podcast feeds: a few anonymous same-origin requests, in parallel with the blobs below.
  const lookups = Promise.all([siteMedia(), feedMedia(pendingFeeds)]);
  const pending = pendingBlobs;
  pendingBlobs = [];
  const urls = [...new Set(pending.map((p) => p.url))];
  const probed = new Map(await Promise.all(urls.map(async (u) => [u, await probeBlob(u)] as const)));
  const uncounted = new Set<string>();
  for (const p of pending) {
    const found = probed.get(p.url);
    if (!found) {
      // A media element playing from a blob: URL we cannot read is most likely fed through MediaSource. List it as a
      // video that can be captured (if the page hook saw how; the background decides), instead of hiding it.
      if (p.counted && p.el instanceof HTMLMediaElement && /^blob:/i.test(p.url)) {
        const id = dataHandle(p.url);
        mseVideos.set(id, p.el);
        if (!uncounted.has(p.url)) {
          uncounted.add(p.url);
          report.notes.blobSources = Math.max(0, report.notes.blobSources - 1);
        }
        if (!report.candidates.some((c) => c.held?.id === id && c.method === p.method))
          report.candidates.push({
            ...p.extra,
            url: dataLabel('application/x-vdh-mse', id),
            method: p.method,
            held: { kind: 'mse', id, bytes: 0 },
          });
      }
      continue;
    }
    const id = dataHandle(p.url);
    const isMedia = /^(video|audio)\//.test(found.mime);
    const kind = isMedia ? undefined : fileKindOfMime(found.mime);
    // only media, images, documents, archives and page assets are listed; anything else stays unreadable
    if (!isMedia && !kind) continue;
    heldBlobs.set(id, found.blob);
    // one URL may be referenced several times (src and <source>): it stops being "unreadable" once
    if (p.counted && !uncounted.has(p.url)) {
      uncounted.add(p.url);
      report.notes.blobSources = Math.max(0, report.notes.blobSources - 1);
    }
    report.candidates.push({
      ...p.extra,
      url: blobLabel(id),
      method: p.method,
      mimeType: found.mime,
      held: { kind: 'blob', id, bytes: found.blob.size },
      ...(kind ? { fileKind: kind } : {}),
    });
  }
  const [site, feeds] = await lookups;
  const have = new Set(report.candidates.map((x) => `${x.url}|${x.method}`));
  for (const m of site)
    if (!have.has(`${m.url}|site-api`)) report.candidates.push(metaCandidate(m, 'site-api'));
  for (const m of feeds)
    if (!have.has(`${m.url}|metadata`)) report.candidates.push(metaCandidate(m, 'metadata'));
  return report;
}

export interface VdhApi {
  scan: typeof scan;
  scanAsync: typeof scanAsync;
  probeHeaders: (url: string) => ReturnType<typeof probeHeaders>;
  fetchText: (url: string) => ReturnType<typeof fetchText>;
  /** Send the page-held bytes behind `handle` to the offscreen document of `jobId`. */
  pumpHeld: (jobId: string, handle: string) => Promise<PumpResult>;
  /** Capture the MediaSource video behind `handle` (resolves when the capture has ended). */
  startCapture: (
    jobId: string,
    handle: string,
    speed: 'fast' | 'realtime',
    labels: BannerLabels,
  ) => Promise<CaptureResult>;
  stopCapture: (jobId: string) => boolean;
  /** Record the MediaStream behind `handle` (resolves when the recording has ended). */
  startRecord: (
    jobId: string,
    handle: string,
    options: RecordOptions,
    labels: BannerLabels,
  ) => Promise<RecordResult>;
  /** Stop a running recording and hand over what it has. */
  finishRecording: (jobId: string) => boolean;
}

const api: VdhApi = {
  scan,
  scanAsync,
  startCapture,
  stopCapture,
  startRecord: (jobId, handle, options, labels) => {
    // The handle is only known after a scan of this document: look again if the page changed since.
    if (!streamMedia.has(handle)) scan();
    return startStreamRecording(jobId, handle, options, labels);
  },
  finishRecording,
  probeHeaders: (url) => probeHeaders(url),
  fetchText: (url) => fetchText(url),
  pumpHeld: async (jobId, handle) => {
    // The handle is only known after a scan of this document: look again if the page changed since.
    if (!heldData.has(handle) && !heldBlobs.has(handle)) await scanAsync();
    const blob = heldBlobs.get(handle);
    if (blob) return pumpBlob(jobId, blob, HELD_BLOB_LIMIT);
    const data = heldData.get(handle);
    return data === undefined
      ? { ok: false, error: 'The page no longer holds this data' }
      : pumpData(jobId, data);
  },
};
(globalThis as unknown as { __vdh?: VdhApi }).__vdh = api;
