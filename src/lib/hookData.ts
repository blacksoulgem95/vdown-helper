import { dataHandle } from './dataUrl';
import { isSafeFetchUrl, normalizeUrl } from './security';
import type { DetectionMethod, MediaResource, RawCandidate } from '@/types/media';

/**
 * What the page hook (src/content/hook.ts, MAIN world) reports. The page controls that world, so every field is
 * untrusted: it is validated and size-capped here before it becomes a candidate.
 */
export interface HookRequest {
  url: string;
  /** Response content type, when the page's own request got a response. */
  contentType?: string;
  via: 'fetch' | 'xhr';
}

export interface HookReport {
  requests: HookRequest[];
  /** Key systems the page asked for through EME (e.g. "com.widevine.alpha"). */
  emeKeySystems: string[];
  /** MediaSources the page created, by the blob: URL it gave its player, with their SourceBuffers. */
  mediaSources: HookMediaSource[];
}

export interface HookMediaSource {
  url: string;
  buffers: Array<{ id: string; mime: string }>;
}

const MAX_REQUESTS = 300;
const MAX_KEY_SYSTEMS = 8;
const MAX_MEDIA_SOURCES = 30;

const MANIFEST_EXT = /\.(m3u8|mpd|ism\/manifest|f4m)(?:$|[?#])/i;
const FILE_EXT =
  /\.(mp4|m4v|webm|mkv|mov|flv|avi|wmv|3gp|mpg|mpeg|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac|vtt|srt|ttml|dfxp)(?:$|[?#])/i;
const MEDIA_TYPE =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|vnd\.ms-sstr\+xml|ogg)|text\/vtt|application\/(x-subrip|ttml\+xml))/i;
/** Media segments are an implementation detail of a manifest and are never listed on their own. */
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|cmft|aac|webvtt|key|bin)(?:$|[?#])/i;

export function isInteresting(req: HookRequest): boolean {
  if (MANIFEST_EXT.test(req.url)) return true;
  if (SEGMENT_EXT.test(req.url) && !/\.(aac)(?:$|[?#])/i.test(req.url)) return false;
  return FILE_EXT.test(req.url) || (req.contentType !== undefined && MEDIA_TYPE.test(req.contentType));
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

/** Parse arbitrary data from the page into a clean report. Never throws. */
export function parseHookReport(raw: unknown): HookReport {
  const out: HookReport = { requests: [], emeKeySystems: [], mediaSources: [] };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r['requests'])) {
    for (const item of r['requests'].slice(0, MAX_REQUESTS * 2)) {
      if (typeof item !== 'object' || item === null) continue;
      const i = item as Record<string, unknown>;
      const url = str(i['url'], 4096);
      if (!url || !isSafeFetchUrl(url)) continue;
      const req: HookRequest = { url, via: i['via'] === 'xhr' ? 'xhr' : 'fetch' };
      const ct = str(i['contentType'], 200);
      if (ct) req.contentType = ct;
      out.requests.push(req);
      if (out.requests.length >= MAX_REQUESTS) break;
    }
  }
  if (Array.isArray(r['mediaSources'])) {
    for (const item of r['mediaSources'].slice(0, MAX_MEDIA_SOURCES)) {
      if (typeof item !== 'object' || item === null) continue;
      const i = item as Record<string, unknown>;
      const url = str(i['url'], 4096);
      if (!url || !/^blob:/i.test(url)) continue;
      const buffers: HookMediaSource['buffers'] = [];
      if (Array.isArray(i['buffers'])) {
        for (const b of i['buffers'].slice(0, 8)) {
          if (typeof b !== 'object' || b === null) continue;
          const id = str((b as Record<string, unknown>)['id'], 20);
          const mime = str((b as Record<string, unknown>)['mime'], 200);
          if (id && /^\d+$/.test(id) && mime) buffers.push({ id, mime });
        }
      }
      out.mediaSources.push({ url, buffers });
    }
  }
  if (Array.isArray(r['emeKeySystems'])) {
    for (const k of r['emeKeySystems'].slice(0, MAX_KEY_SYSTEMS)) {
      const ks = str(k, 100);
      if (ks && /^[a-z0-9.-]+$/i.test(ks)) out.emeKeySystems.push(ks.toLowerCase());
    }
  }
  return out;
}

/** Candidates for the interesting requests, deduplicated by normalised URL. */
export function hookCandidates(
  report: HookReport,
  frame: { frameId?: number; frameUrl?: string },
): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const req of report.requests) {
    if (!isInteresting(req)) continue;
    const key = normalizeUrl(req.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const method: DetectionMethod = 'hook';
    const c: RawCandidate = { url: req.url, method };
    if (req.contentType) c.mimeType = req.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (frame.frameId !== undefined) c.frameId = frame.frameId;
    if (frame.frameUrl) c.frameUrl = frame.frameUrl;
    out.push(c);
  }
  return out;
}

/** Key systems that mean the stream is protected. ClearKey delivers its key in the clear and is not DRM. */
export function protectedKeySystems(systems: string[]): string[] {
  return systems.filter((s) => s !== 'org.w3.clearkey');
}

/**
 * Resources found in a frame whose page asked for a DRM key system are protected: refuse them, whatever their
 * container says. (The page's player will be decrypting them with a licence we neither can nor will obtain.)
 */
export function markProtectedFrames(
  resources: MediaResource[],
  protectedByFrame: Map<number, string[]>,
): MediaResource[] {
  if (protectedByFrame.size === 0) return resources;
  return resources.map((r) => {
    const systems = r.frameId !== undefined ? protectedByFrame.get(r.frameId) : undefined;
    if (!systems || systems.length === 0) return r;
    return {
      ...r,
      downloadability: { status: 'protected', reason: 'eme', detail: systems[0] as string },
    };
  });
}

/** Why the page hook has nothing to say about a frame: switched off, not allowed on that site, or there too late. */
export type MseMissing = 'mse-needs-hook' | 'mse-needs-access' | 'mse-needs-reload';

export function mseMissingReason(hookOn: boolean, siteAllowed: boolean): MseMissing {
  if (!hookOn) return 'mse-needs-hook';
  return siteAllowed ? 'mse-needs-reload' : 'mse-needs-access';
}

/**
 * Decide whether a MediaSource player (`held.kind === 'mse'`) can be captured, from what the page hook of its own
 * frame saw. Without the hook there is no way to know how the player is fed; `missing` says why it is not there.
 */
export function markMseResources(
  resources: MediaResource[],
  reports: Map<number, HookReport>,
  missing: ReadonlyMap<number, MseMissing> = new Map(),
): MediaResource[] {
  return resources.map((r) => {
    if (r.held?.kind !== 'mse') return r;
    const report = reports.get(r.frameId ?? 0);
    if (!report) {
      const reason = missing.get(r.frameId ?? 0);
      return reason ? { ...r, downloadability: { status: 'unsupported', reason } } : r;
    }
    const source = report.mediaSources.find((m) => dataHandle(m.url) === r.held?.id);
    const verdict = (d: MediaResource['downloadability']) => ({ ...r, downloadability: d });
    if (!source || source.buffers.length === 0)
      return verdict({ status: 'unsupported', reason: 'mse-unrecordable' });
    // Any key system means the data the player is given is encrypted: nothing usable could be recorded.
    if (report.emeKeySystems.length > 0) {
      return protectedKeySystems(report.emeKeySystems).length > 0
        ? verdict({
            status: 'protected',
            reason: 'eme',
            detail: protectedKeySystems(report.emeKeySystems)[0] as string,
          })
        : verdict({ status: 'unsupported', reason: 'mse-unrecordable', detail: 'clearkey' });
    }
    return verdict({ status: 'downloadable', reason: 'ok', detail: 'mse-capturable' });
  });
}
