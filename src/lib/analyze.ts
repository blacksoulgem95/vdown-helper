import type { HlsMasterPlaylist, HlsMediaPlaylist, HlsRendition, HlsVariant } from '@/types/hls';
import type {
  Downloadability,
  MediaFormat,
  MediaResource,
  PlaylistSummary,
  RawCandidate,
} from '@/types/media';
import { classifyPlaylist, parseHls } from './hls/parser';
import { dashRef } from './dash/ref';
import {
  DashExpandError,
  expandSegments,
  mainPeriodIndex,
  parseDash,
  periodDuration,
  protectionsOf,
} from './dash/parser';
import { estimateBytes, formatFromMime, formatFromUrl, inferTitle, mediaTypeOf } from './media';
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
  methods: RawCandidate['method'][];
  frameId?: number;
  frameUrl?: string;
  hints: Pick<
    RawCandidate,
    'title' | 'mimeType' | 'mediaType' | 'durationSec' | 'width' | 'height' | 'poster'
  >;
}

const PLAYLIST_FORMATS: ReadonlySet<MediaFormat> = new Set(['hls', 'm3u', 'dash']);
const MAX_VARIANTS = 50;
const MAX_AUDIO_TRACKS = 50;
const MAX_TEXT = 200;
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function collectEntries(cands: RawCandidate[]): Entry[] {
  const map = new Map<string, Entry>();
  for (const c of cands) {
    if (!isSafeFetchUrl(c.url)) continue;
    const key = normalizeUrl(c.url);
    const prev = map.get(key);
    const hints = {
      ...(c.title ? { title: c.title } : {}),
      ...(c.mimeType ? { mimeType: c.mimeType } : {}),
      ...(c.mediaType ? { mediaType: c.mediaType } : {}),
      ...(c.durationSec ? { durationSec: c.durationSec } : {}),
      ...(c.width ? { width: c.width, height: c.height } : {}),
      ...(c.poster ? { poster: c.poster } : {}),
    };
    if (prev) {
      if (!prev.methods.includes(c.method)) prev.methods.push(c.method);
      prev.hints = { ...hints, ...prev.hints };
    } else {
      map.set(key, {
        url: c.url,
        methods: [c.method],
        hints,
        ...(c.frameId !== undefined ? { frameId: c.frameId } : {}),
        ...(c.frameUrl ? { frameUrl: c.frameUrl } : {}),
      });
    }
  }
  return [...map.values()];
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

async function analyzePlaylist(r: MediaResource, fetcher: Fetcher): Promise<MediaResource> {
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

async function analyzeFile(r: MediaResource, e: Entry, fetcher: Fetcher): Promise<MediaResource> {
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
    return analyzePlaylist(r, fetcher);
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

async function analyzeOne(e: Entry, ctx: AnalyzeContext, fetcher: Fetcher): Promise<MediaResource> {
  const format = formatFromMime(e.hints.mimeType) ?? formatFromUrl(e.url) ?? 'unknown';
  const r = skeleton(e, ctx, format);
  if (PLAYLIST_FORMATS.has(format)) return analyzePlaylist(r, fetcher);
  return analyzeFile(r, e, fetcher);
}

/** Probe candidates and build deduplicated resources with downloadability verdicts. */
export async function analyzeCandidates(
  candidates: RawCandidate[],
  ctx: AnalyzeContext,
  fetcher: Fetcher,
  opts: AnalyzeOptions = {},
): Promise<MediaResource[]> {
  const entries = collectEntries(candidates).slice(0, opts.maxResources ?? 60);
  const resources = await mapPool(entries, opts.concurrency ?? 4, async (e) => {
    try {
      return await analyzeOne(e, ctx, fetcher);
    } catch {
      const r = skeleton(e, ctx, formatFromUrl(e.url) ?? 'unknown');
      r.downloadability = verdict('unknown', 'network');
      return r;
    }
  });
  return hideCoveredVariants(dedupeResources(resources));
}

/** A resource as shown before probing completes: facts from the page only. */
export function provisionalResources(candidates: RawCandidate[], ctx: AnalyzeContext): MediaResource[] {
  return dedupeResources(
    collectEntries(candidates).map((e) =>
      skeleton(e, ctx, formatFromMime(e.hints.mimeType) ?? formatFromUrl(e.url) ?? 'unknown'),
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
