import type { HlsMasterPlaylist, HlsMediaPlaylist, HlsRendition, HlsVariant } from '@/types/hls';
import type {
  Downloadability,
  MediaFormat,
  MediaResource,
  PageHeld,
  PlaylistSummary,
  RawCandidate,
} from '@/types/media';
import { classifyPlaylist, parseHls } from './hls/parser';
import { dashRef } from './dash/ref';
import { extensionForMime, fileStem, urlExtension, type FileKind } from './filetypes';
import { exceedsHeldLimit, isDataLabel } from './dataUrl';
import { MAX_HELD_BYTES } from '@/types/ingest';
import {
  DashExpandError,
  expandSegments,
  mainPeriodIndex,
  parseDash,
  periodDuration,
  protectionsOf,
} from './dash/parser';
import {
  estimateBytes,
  formatFromMime,
  formatFromUrl,
  inferTitle,
  mediaTypeOf,
  SUBTITLE_FILE_FORMATS,
} from './media';
import type { ProbeResult } from './netprobe';
import { dedupeResources, hideCoveredVariants, resourceId } from './resources';
import { isSafeFetchUrl, normalizeUrl, parseUrl } from './security';

/** Network access used while analysing. Implementations decide which origin the request is made from. */
export interface Fetcher {
  /** `frameId` is the frame the URL was found in: reads are made from that frame's origin when possible. */
  head(url: string, frameId?: number): Promise<ProbeResult>;
  text(url: string, frameId?: number): Promise<ProbeResult>;
}

export interface AnalyzeContext {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  now: number;
}

export interface AnalyzeOptions {
  concurrency?: number;
  /** Cap on how many candidates are probed in one scan. */
  maxResources?: number;
}

interface Entry {
  url: string;
  held?: PageHeld;
  methods: RawCandidate['method'][];
  frameId?: number;
  frameUrl?: string;
  hints: Pick<
    RawCandidate,
    | 'title'
    | 'mimeType'
    | 'mediaType'
    | 'durationSec'
    | 'width'
    | 'height'
    | 'poster'
    | 'role'
    | 'language'
    | 'fileKind'
    | 'sizeBytes'
  >;
}

const PLAYLIST_FORMATS: ReadonlySet<MediaFormat> = new Set(['hls', 'm3u', 'dash']);
const MAX_VARIANTS = 50;
const MAX_AUDIO_TRACKS = 50;
const MAX_SUBTITLE_TRACKS = 30;
const MAX_DERIVED_SUBTITLES = 60;
const MAX_TEXT = 200;
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function collectEntries(cands: RawCandidate[]): Entry[] {
  const map = new Map<string, Entry>();
  for (const c of cands) {
    // A page-held source is only a label; the extension never fetches it, so it needs no fetchable URL.
    if (c.held ? !isDataLabel(c.url) : !isSafeFetchUrl(c.url)) continue;
    const key = normalizeUrl(c.url);
    const prev = map.get(key);
    const hints = {
      ...(c.title ? { title: c.title } : {}),
      ...(c.mimeType ? { mimeType: c.mimeType } : {}),
      ...(c.mediaType ? { mediaType: c.mediaType } : {}),
      ...(c.durationSec ? { durationSec: c.durationSec } : {}),
      ...(c.width ? { width: c.width, height: c.height } : {}),
      ...(c.poster ? { poster: c.poster } : {}),
      ...(c.role ? { role: c.role } : {}),
      ...(c.fileKind ? { fileKind: c.fileKind } : {}),
      ...(c.sizeBytes ? { sizeBytes: c.sizeBytes } : {}),
      ...(c.language ? { language: clip(c.language) } : {}),
    };
    if (prev) {
      if (!prev.methods.includes(c.method)) prev.methods.push(c.method);
      prev.hints = { ...hints, ...prev.hints };
    } else {
      map.set(key, {
        url: c.url,
        ...(c.held ? { held: c.held } : {}),
        methods: [c.method],
        hints,
        ...(c.frameId !== undefined ? { frameId: c.frameId } : {}),
        ...(c.frameUrl ? { frameUrl: c.frameUrl } : {}),
      });
    }
  }
  return [...map.values()];
}

/** Per-kind caps on what is analysed in one scan: media is probed deeply, so it gets the tightest limit. */
export const FILE_CAPS = { image: 300, document: 100, archive: 100, asset: 200 } as const;

function capEntries(entries: Entry[], maxMedia: number): Entry[] {
  const left: Record<string, number> = { media: maxMedia, ...FILE_CAPS };
  return entries.filter((e) => {
    const bucket = e.hints.fileKind ?? 'media';
    return (left[bucket] = (left[bucket] ?? 0) - 1) >= 0;
  });
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const verdict = (
  status: Downloadability['status'],
  reason: Downloadability['reason'],
  detail?: string,
): Downloadability => (detail === undefined ? { status, reason } : { status, reason, detail });

function failureVerdict(r: Extract<ProbeResult, { ok: false }>): Downloadability {
  if (r.kind === 'http') return verdict('inaccessible', 'http-error', `HTTP ${r.status ?? '?'}`);
  if (r.kind === 'timeout') return verdict('unknown', 'network', 'timeout');
  return verdict('inaccessible', 'cors');
}

function skeleton(e: Entry, ctx: AnalyzeContext, format: MediaFormat): MediaResource {
  const pageHost = parseUrl(ctx.pageUrl)?.hostname ?? parseUrl(e.url)?.hostname ?? '';
  const titleOpts: { url: string; elementTitle?: string; pageTitle?: string } = {
    url: e.url,
    pageTitle: clip(ctx.pageTitle),
  };
  if (e.hints.title) titleOpts.elementTitle = e.hints.title;
  const r: MediaResource = {
    id: resourceId(e.url),
    url: e.url,
    tabId: ctx.tabId,
    pageUrl: ctx.pageUrl,
    pageTitle: clip(ctx.pageTitle),
    host: pageHost,
    title: clip(inferTitle(titleOpts)),
    kind: 'file',
    format,
    mediaType: e.hints.mediaType ?? mediaTypeOf(format),
    detectedBy: [...e.methods],
    downloadability: verdict('unknown', 'not-probed'),
    variants: [],
    audioTracks: [],
    detectedAt: ctx.now,
  };
  if (e.hints.mimeType) r.mimeType = e.hints.mimeType;
  if (e.hints.durationSec) r.durationSec = e.hints.durationSec;
  if (e.hints.width) {
    r.width = e.hints.width;
    if (e.hints.height) r.height = e.hints.height;
  }
  if (e.hints.poster) r.poster = e.hints.poster;
  if (e.hints.language) r.language = e.hints.language;
  if (e.held) r.held = e.held;
  if (e.hints.fileKind) {
    // A plain file: named as the server names it, with the extension its URL (or MIME type) gives.
    r.kind = e.hints.fileKind;
    r.format = 'unknown';
    r.mediaType = 'unknown';
    r.ext = (e.held ? '' : urlExtension(e.url)) || extensionForMime(e.hints.mimeType) || '';
    r.title = clip((e.held ? `inline-${e.held.id}` : fileStem(e.url)) || pageHost || clip(ctx.pageTitle));
    if (e.hints.sizeBytes) r.sizeBytes = e.hints.sizeBytes;
  } else if (e.hints.role === 'subtitle') {
    r.kind = 'subtitle';
  }
  if (e.frameId !== undefined) r.frameId = e.frameId;
  if (e.frameUrl) r.frameUrl = e.frameUrl;
  return r;
}

/** Verdict for a parsed media playlist. */
export function mediaPlaylistVerdict(p: HlsMediaPlaylist): Downloadability {
  if (p.hasDrm) {
    const sample = p.encryption.some((m) => m === 'SAMPLE-AES' || m === 'SAMPLE-AES-CTR');
    return verdict('protected', sample ? 'sample-aes' : 'drm');
  }
  if (!p.endList) return verdict('unsupported', 'live', 'live-or-event');
  if (p.encryption.includes('AES-128')) return verdict('downloadable', 'ok', 'aes-128');
  return verdict('downloadable', 'ok');
}

function summaryOf(p: HlsMediaPlaylist, cls: PlaylistSummary['playlistClass']): PlaylistSummary {
  const s: PlaylistSummary = {
    playlistClass: cls,
    segmentCount: p.segments.length,
    live: !p.endList,
    encryption: p.encryption,
    fragmented: p.fragmented,
  };
  if (p.targetDuration !== undefined) s.targetDuration = p.targetDuration;
  return s;
}

function applyVariantTop(r: MediaResource, top: HlsVariant | undefined): void {
  if (!top) return;
  r.bitrate = top.averageBandwidth ?? top.bandwidth;
  if (top.width) r.width = top.width;
  if (top.height) r.height = top.height;
  if (top.frameRate) r.frameRate = top.frameRate;
  if (top.codecs) r.codecs = top.codecs;
}

/** Segment resources of subtitle playlists: they belong to their playlist and are never listed on their own. */
type Covered = Set<string>;

const VTT_SEGMENT = /\.(web)?vtt(?:$|[?#])/i;

function isSubtitlePlaylist(p: HlsMediaPlaylist): boolean {
  return p.segments.length > 0 && p.segments.every((s) => VTT_SEGMENT.test(s.uri));
}

function coverSegments(p: HlsMediaPlaylist, covered: Covered): void {
  for (const s of p.segments) covered.add(resourceId(s.uri));
}

async function analyzePlaylist(r: MediaResource, fetcher: Fetcher, covered: Covered): Promise<MediaResource> {
  const res = await fetcher.text(r.url, r.frameId);
  if (!res.ok) {
    r.kind = r.format === 'dash' ? 'unsupported-playlist' : 'hls-media';
    r.downloadability = failureVerdict(res);
    return r;
  }
  const text = res.text ?? '';
  if (classifyPlaylist(text) === 'dash') return analyzeDash(r, text, res.finalUrl || r.url);
  const parsed = parseHls(text, res.finalUrl || r.url);
  if (!parsed.ok) {
    const e = parsed.error;
    r.kind = 'unsupported-playlist';
    if (e.code === 'dash') {
      r.format = 'dash';
      r.playlist = { playlistClass: 'dash', encryption: [] };
      r.downloadability = verdict('unsupported', 'dash');
    } else if (e.code === 'not-hls') {
      r.format = 'm3u';
      r.mediaType = 'unknown';
      r.playlist = { playlistClass: 'm3u-plain', encryption: [] };
      r.downloadability = verdict('unsupported', 'plain-m3u');
    } else if (e.code === 'not-m3u') {
      r.playlist = { playlistClass: classifyPlaylist(text), encryption: [] };
      r.downloadability = verdict('unsupported', 'unsupported-format');
    } else if (e.code === 'unsafe-url') {
      r.downloadability = verdict('unsupported', 'unsafe-url');
    } else {
      r.downloadability = verdict('unsupported', 'malformed', e.line ? `line ${e.line}` : e.code);
    }
    return r;
  }

  r.format = 'hls';
  const pl = parsed.playlist;
  if (pl.kind === 'hls-media') {
    r.kind = 'hls-media';
    r.durationSec = pl.totalDuration;
    r.playlist = summaryOf(pl, 'hls-media');
    r.downloadability = mediaPlaylistVerdict(pl);
    if (isSubtitlePlaylist(pl)) {
      // A WebVTT playlist found on its own (the player loaded it directly): it is a subtitle, not a video.
      r.kind = 'subtitle';
      r.mediaType = 'unknown';
      coverSegments(pl, covered);
    }
    return r;
  }

  return finishMaster(r, pl, fetcher);
}

async function finishMaster(
  r: MediaResource,
  pl: HlsMasterPlaylist,
  fetcher: Fetcher,
): Promise<MediaResource> {
  r.kind = 'hls-master';
  r.variants = pl.variants.slice(0, MAX_VARIANTS);
  r.audioTracks = pl.renditions
    .filter((x) => x.type === 'AUDIO' && x.uri)
    .slice(0, MAX_AUDIO_TRACKS)
    .map((a) => ({ ...a, name: clip(a.name), groupId: clip(a.groupId) }));
  r.subtitleTracks = pl.renditions
    .filter((x) => x.type === 'SUBTITLES' && x.uri)
    .slice(0, MAX_SUBTITLE_TRACKS)
    .map((s) => ({ ...s, name: clip(s.name), groupId: clip(s.groupId) }));
  applyVariantTop(r, r.variants[0]);
  const audioOnly = r.variants.length === 0 && r.audioTracks.length > 0;
  if (audioOnly) r.mediaType = 'audio';
  else r.mediaType = 'video';
  r.playlist = { playlistClass: 'hls-master', encryption: [] };

  if (pl.sessionKeys.some((k) => k.protectedByDrm)) {
    r.downloadability = verdict('protected', 'drm');
    return r;
  }

  const sampleUrl = r.variants[0]?.uri ?? r.audioTracks[0]?.uri;
  if (!sampleUrl) {
    r.downloadability = verdict('unsupported', 'no-segments');
    return r;
  }
  const sample = await fetcher.text(sampleUrl, r.frameId);
  if (!sample.ok) {
    r.downloadability = { ...failureVerdict(sample), detail: 'variant-playlist' };
    return r;
  }
  const media = parseHls(sample.text ?? '', sample.finalUrl || sampleUrl);
  if (!media.ok || media.playlist.kind !== 'hls-media') {
    r.downloadability = verdict('unsupported', 'malformed', 'variant-playlist');
    return r;
  }
  const mp = media.playlist;
  r.durationSec = mp.totalDuration;
  r.playlist = summaryOf(mp, 'hls-master');
  r.downloadability = mediaPlaylistVerdict(mp);
  const bytes = estimateBytes(r.bitrate, mp.totalDuration);
  if (bytes !== undefined) {
    r.sizeBytes = bytes;
    r.sizeIsEstimate = true;
  }
  return r;
}

async function analyzeFile(
  r: MediaResource,
  e: Entry,
  fetcher: Fetcher,
  covered: Covered,
): Promise<MediaResource> {
  const head = await fetcher.head(e.url, e.frameId);
  if (!head.ok) {
    if (head.kind === 'blocked') {
      // Chrome's own download manager is not subject to CORS, so the file can still be fetched; only the
      // header details (size, type) are unreadable from here.
      r.downloadability = verdict('downloadable', 'ok', 'headers-unreadable');
    } else {
      r.downloadability = failureVerdict(head);
    }
    return r;
  }
  const mime = head.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const fromMime = formatFromMime(mime);
  if (fromMime && PLAYLIST_FORMATS.has(fromMime)) {
    r.format = fromMime;
    return analyzePlaylist(r, fetcher, covered);
  }
  if (mime) r.mimeType = mime;
  if (fromMime) {
    r.format = fromMime;
    r.mediaType = e.hints.mediaType ?? mediaTypeOf(fromMime);
  }
  const looksMedia =
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime === 'application/octet-stream' ||
    mime === '' ||
    mime === 'binary/octet-stream';
  if (
    r.format === 'unknown' &&
    !looksMedia &&
    !e.methods.includes('dom-element') &&
    !e.methods.includes('dom-source')
  ) {
    r.downloadability = verdict('unsupported', 'unsupported-format', mime);
    return r;
  }
  if (head.contentLength !== undefined) r.sizeBytes = head.contentLength;
  r.downloadability = verdict('downloadable', 'ok');
  return r;
}

/** A subtitle document: a `<track>`, or a .vtt/.srt/.ttml file. Saved as found, or converted to SRT. */
async function analyzeSubtitleFile(r: MediaResource, e: Entry, fetcher: Fetcher): Promise<MediaResource> {
  r.kind = 'subtitle';
  r.mediaType = 'unknown';
  // The HTML spec says <track> sources are WebVTT; anything else is named by its MIME type or extension.
  if (!SUBTITLE_FILE_FORMATS.has(r.format)) r.format = e.hints.role === 'subtitle' ? 'vtt' : r.format;
  const head = await fetcher.head(e.url, e.frameId);
  if (!head.ok) {
    r.downloadability =
      head.kind === 'blocked' ? verdict('downloadable', 'ok', 'headers-unreadable') : failureVerdict(head);
    return r;
  }
  const mime = head.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    mime === 'text/html' ||
    mime.startsWith('image/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/')
  ) {
    r.downloadability = verdict('unsupported', 'unsupported-format', mime);
    return r;
  }
  const fromMime = formatFromMime(mime);
  if (fromMime && SUBTITLE_FILE_FORMATS.has(fromMime)) r.format = fromMime;
  if (mime) r.mimeType = mime;
  if (head.contentLength !== undefined) r.sizeBytes = head.contentLength;
  r.downloadability = verdict('downloadable', 'ok');
  return r;
}

/** Media embedded in the page as a data: URL: nothing to probe, its size is known and the page hands it over. */
function analyzeHeld(r: MediaResource, e: Entry, ctx: AnalyzeContext): MediaResource {
  const held = e.held as PageHeld;
  r.sizeBytes = held.bytes;
  if (!e.hints.title && !e.hints.fileKind) r.title = clip(ctx.pageTitle) || r.host;
  r.downloadability = exceedsHeldLimit(held.bytes)
    ? verdict('unsupported', 'too-large', `${MAX_HELD_BYTES}`)
    : verdict('downloadable', 'ok', 'in-page-data');
  return r;
}

/** How many plain files per scan get a HEAD request; the rest are listed from what the page already told us. */
const FILE_HEAD_BUDGET = 150;

/**
 * An image, document, archive or page asset. The page usually already knows its size and dimensions, so a HEAD request
 * (one per file) is only made while the budget lasts; it confirms the type and catches dead links.
 */
async function analyzeFileKind(
  r: MediaResource,
  e: Entry,
  ctx: AnalyzeContext,
  fetcher: Fetcher,
  budget: { head: number },
): Promise<MediaResource> {
  const kind = e.hints.fileKind as FileKind;
  if (e.held) return analyzeHeld(r, e, ctx);
  if (budget.head <= 0) {
    r.downloadability = verdict('downloadable', 'ok');
    return r;
  }
  budget.head--;
  const head = await fetcher.head(e.url, e.frameId);
  if (!head.ok) {
    r.downloadability =
      head.kind === 'blocked' ? verdict('downloadable', 'ok', 'headers-unreadable') : failureVerdict(head);
    return r;
  }
  const mime = head.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  // A link that answers with a web page is not the file it claims to be.
  if (mime === 'text/html' && kind !== 'document') {
    r.downloadability = verdict('unsupported', 'unsupported-format', mime);
    return r;
  }
  if (mime) r.mimeType = mime;
  if (!r.ext) r.ext = extensionForMime(mime) ?? '';
  if (head.contentLength !== undefined) r.sizeBytes = head.contentLength;
  r.downloadability = verdict('downloadable', 'ok');
  return r;
}

async function analyzeOne(
  e: Entry,
  ctx: AnalyzeContext,
  fetcher: Fetcher,
  covered: Covered,
  budget: { head: number },
): Promise<MediaResource> {
  const format = formatFromMime(e.hints.mimeType) ?? formatFromUrl(e.url) ?? 'unknown';
  const r = skeleton(e, ctx, e.hints.fileKind ? 'unknown' : format);
  if (e.hints.fileKind) return analyzeFileKind(r, e, ctx, fetcher, budget);
  if (e.held) return analyzeHeld(r, e, ctx);
  if (e.hints.role === 'subtitle' || SUBTITLE_FILE_FORMATS.has(format))
    return analyzeSubtitleFile(r, e, fetcher);
  if (PLAYLIST_FORMATS.has(format)) return analyzePlaylist(r, fetcher, covered);
  return analyzeFile(r, e, fetcher, covered);
}

/** Codecs of text tracks this extension cannot turn into a subtitle file (WebVTT-in-MP4 cues, image subtitles). */
const UNREADABLE_TEXT = /wvtt|stpp\.ttml\.im1i|dvbs|bitmap/i;

/**
 * Subtitle renditions listed by HLS and DASH manifests become subtitle resources of their own. An HLS rendition is a
 * media playlist, read once to learn its length and whether it is protected or live.
 */
export async function deriveSubtitleResources(
  parents: MediaResource[],
  ctx: AnalyzeContext,
  fetcher: Fetcher,
  covered: Covered,
): Promise<MediaResource[]> {
  const jobs: Array<{ parent: MediaResource; track: HlsRendition }> = [];
  for (const parent of parents)
    for (const track of parent.subtitleTracks ?? []) if (track.uri) jobs.push({ parent, track });
  const results = await mapPool(jobs.slice(0, MAX_DERIVED_SUBTITLES), 4, async ({ parent, track }) => {
    const uri = track.uri as string;
    const isDash = parent.kind === 'dash';
    const e: Entry = {
      url: uri,
      methods: [...parent.detectedBy],
      hints: {
        title: `${parent.title} · ${track.name}`,
        role: 'subtitle',
        ...(track.language ? { language: track.language } : {}),
      },
      ...(parent.frameId !== undefined ? { frameId: parent.frameId } : {}),
      ...(parent.frameUrl ? { frameUrl: parent.frameUrl } : {}),
    };
    const r = skeleton(e, ctx, isDash ? 'dash' : 'hls');
    r.kind = 'subtitle';
    r.mediaType = 'unknown';
    if (track.language) r.language = track.language;
    if (track.codecs && UNREADABLE_TEXT.test(track.codecs)) {
      r.downloadability = verdict('unsupported', 'subtitle-unsupported', track.codecs);
      return r;
    }
    if (isDash) {
      // The manifest was already parsed; protection and liveness were decided there.
      r.downloadability = verdict('downloadable', 'ok');
      if (parent.durationSec) r.durationSec = parent.durationSec;
      return r;
    }
    try {
      const res = await fetcher.text(uri, parent.frameId);
      if (!res.ok) {
        r.downloadability = failureVerdict(res);
        return r;
      }
      const parsed = parseHls(res.text ?? '', res.finalUrl || uri);
      if (!parsed.ok || parsed.playlist.kind !== 'hls-media') {
        r.downloadability = verdict('unsupported', 'malformed', 'subtitle-playlist');
        return r;
      }
      const pl = parsed.playlist;
      r.durationSec = pl.totalDuration;
      r.playlist = summaryOf(pl, 'hls-media');
      r.downloadability = mediaPlaylistVerdict(pl);
      coverSegments(pl, covered);
    } catch {
      r.downloadability = verdict('unknown', 'network');
    }
    return r;
  });
  return results;
}

/** Probe candidates and build deduplicated resources with downloadability verdicts. */
export async function analyzeCandidates(
  candidates: RawCandidate[],
  ctx: AnalyzeContext,
  fetcher: Fetcher,
  opts: AnalyzeOptions = {},
): Promise<MediaResource[]> {
  const entries = capEntries(collectEntries(candidates), opts.maxResources ?? 60);
  const covered: Covered = new Set();
  const budget = { head: FILE_HEAD_BUDGET };
  const resources = await mapPool(entries, opts.concurrency ?? 4, async (e) => {
    try {
      return await analyzeOne(e, ctx, fetcher, covered, budget);
    } catch {
      const r = skeleton(e, ctx, e.hints.fileKind ? 'unknown' : (formatFromUrl(e.url) ?? 'unknown'));
      r.downloadability = verdict('unknown', 'network');
      return r;
    }
  });
  const subtitles = await deriveSubtitleResources(resources, ctx, fetcher, covered);
  return hideCoveredVariants(
    dedupeResources([...resources, ...subtitles]).filter(
      (r) => !(r.kind === 'subtitle' && r.format !== 'hls' && r.format !== 'dash' && covered.has(r.id)),
    ),
  );
}

/** A resource as shown before probing completes: facts from the page only. */
export function provisionalResources(candidates: RawCandidate[], ctx: AnalyzeContext): MediaResource[] {
  return dedupeResources(
    collectEntries(candidates).map((e) =>
      skeleton(
        e,
        ctx,
        e.hints.fileKind
          ? 'unknown'
          : (formatFromMime(e.hints.mimeType) ?? formatFromUrl(e.url) ?? 'unknown'),
      ),
    ),
  );
}

/** Describe an MPEG-DASH manifest: its real representations, duration, protection and addressing. */
function analyzeDash(r: MediaResource, text: string, url: string): MediaResource {
  r.format = 'dash';
  const parsed = parseDash(text, url);
  if (!parsed.ok) {
    r.kind = 'unsupported-playlist';
    r.playlist = { playlistClass: 'dash', encryption: [] };
    r.downloadability =
      parsed.error.code === 'unsafe-url'
        ? verdict('unsupported', 'unsafe-url')
        : verdict('unsupported', 'malformed', parsed.error.code);
    return r;
  }
  const m = parsed.manifest;
  const period = m.periods[mainPeriodIndex(m)];
  if (!period) {
    r.kind = 'unsupported-playlist';
    r.downloadability = verdict('unsupported', 'malformed');
    return r;
  }
  r.kind = 'dash';
  const videos = period.representations
    .filter((x) => x.content === 'video')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)
    .slice(0, MAX_VARIANTS);
  const audios = period.representations.filter((x) => x.content === 'audio').slice(0, MAX_AUDIO_TRACKS);
  const hasAudioCodec = (codecs: string | undefined) => /mp4a|ac-3|ec-3|opus|vorbis|flac/i.test(codecs ?? '');
  r.variants = videos.map((x) => {
    const v: HlsVariant = { uri: dashRef(url, x.id), bandwidth: x.bandwidth };
    if (x.width) v.width = x.width;
    if (x.height) v.height = x.height;
    if (x.frameRate) v.frameRate = x.frameRate;
    if (x.codecs) v.codecs = x.codecs;
    // Separate audio is only offered for video that does not already carry it.
    if (audios.length > 0 && !hasAudioCodec(x.codecs)) v.audioGroup = 'dash-audio';
    return v;
  });
  r.audioTracks = audios.map((x, i) => {
    const t: HlsRendition = {
      type: 'AUDIO',
      groupId: 'dash-audio',
      name: clip(x.label ?? x.lang ?? x.id),
      uri: dashRef(url, x.id),
      isDefault: i === 0,
      autoSelect: true,
    };
    if (x.lang) t.language = x.lang;
    if (x.codecs) t.codecs = x.codecs;
    return t;
  });
  const texts = period.representations.filter((x) => x.content === 'text').slice(0, MAX_SUBTITLE_TRACKS);
  if (m.type === 'static' && texts.length > 0) {
    r.subtitleTracks = texts.map((x) => {
      const t: HlsRendition = {
        type: 'SUBTITLES',
        groupId: 'dash-text',
        name: clip(x.label ?? x.lang ?? x.id),
        uri: dashRef(url, x.id),
        isDefault: false,
        autoSelect: false,
      };
      if (x.lang) t.language = x.lang;
      // The codec decides whether the track can be read (wvtt/image tracks cannot), the MIME type is the fallback.
      const codec = x.codecs ?? x.mimeType;
      if (codec) t.codecs = codec;
      return t;
    });
  }
  r.mediaType = videos.length > 0 ? 'video' : 'audio';
  applyVariantTop(r, r.variants[0]);
  if (videos.length === 0 && audios[0]) r.bitrate = audios[0].bandwidth;
  const dur = periodDuration(m, period);
  if (dur !== undefined) r.durationSec = dur;

  const top = videos[0] ?? audios[0];
  let segmentCount: number | undefined;
  if (top && m.type === 'static') {
    try {
      segmentCount = expandSegments(m, period, top).segments.length;
    } catch (e) {
      r.downloadability = verdict(
        'unsupported',
        'malformed',
        e instanceof DashExpandError ? 'segments' : 'expand',
      );
      r.playlist = { playlistClass: 'dash', encryption: [], periods: m.periods.length };
      return r;
    }
  }
  r.playlist = {
    playlistClass: 'dash',
    encryption: [],
    fragmented: true,
    live: m.type === 'dynamic',
    periods: m.periods.length,
    ...(segmentCount !== undefined ? { segmentCount } : {}),
  };
  const prot = protectionsOf(period.representations);
  if (prot.drm) {
    r.downloadability = verdict('protected', 'drm', prot.systems.join(','));
  } else if (prot.clearKey) {
    // Encrypted with ClearKey: only downloadable once its key can be obtained (not implemented yet).
    r.downloadability = verdict('unsupported', 'dash-clearkey');
  } else if (m.type === 'dynamic') {
    r.downloadability = verdict('unsupported', 'live', 'live-or-event');
  } else if (!top) {
    r.downloadability = verdict('unsupported', 'no-segments');
  } else {
    r.downloadability = verdict('downloadable', 'ok');
    const size = estimateBytes(r.bitrate, dur);
    if (size !== undefined) {
      r.sizeBytes = size;
      r.sizeIsEstimate = true;
    }
  }
  return r;
}
