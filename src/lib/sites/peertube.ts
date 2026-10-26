import type { MetaMedia } from '../metadata';
import { safeAbs } from '../metadata';
import type { SiteLookup } from './types';

/**
 * PeerTube is software, not one site: any instance serves `/w/<id>` or `/videos/watch/<id>` and the same public API
 * (`/api/v1/videos/<id>`), so it is recognised by that address and confirmed by the shape of the answer.
 */
export function peertubeLookup(page: URL): SiteLookup | undefined {
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return undefined;
  const m = /^\/(?:w|videos\/(?:watch|embed))\/([A-Za-z0-9-]{8,40})\/?$/.exec(page.pathname);
  if (!m) return undefined;
  return {
    site: 'peertube',
    apiUrl: new URL(`/api/v1/videos/${m[1]}`, page.origin).href,
    parse: (json) => parsePeertube(json, page.origin),
  };
}

interface Rec {
  [k: string]: unknown;
}
const rec = (v: unknown): Rec | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;

/** The video's web-video files (one per resolution) and its HLS playlist. A live stream has none to offer here. */
export function parsePeertube(json: unknown, origin: string): MetaMedia[] {
  const v = rec(json);
  // the shape of a PeerTube video: anything else is not an answer from PeerTube
  if (!v || typeof v['uuid'] !== 'string' || !Array.isArray(v['files']) || typeof v['name'] !== 'string')
    return [];
  if (v['isLive'] === true) return [];
  const name = (v['name'] as string).trim().slice(0, 160);
  const duration = typeof v['duration'] === 'number' && v['duration'] > 0 ? v['duration'] : undefined;
  const poster = safeAbs(typeof v['thumbnailPath'] === 'string' ? v['thumbnailPath'] : undefined, origin);
  const out: MetaMedia[] = [];
  const files = (v['files'] as unknown[]).map(rec).filter((f): f is Rec => f !== undefined);
  files.sort((a, b) => Number(rec(b['resolution'])?.['id'] ?? 0) - Number(rec(a['resolution'])?.['id'] ?? 0));
  for (const f of files.slice(0, 12)) {
    const url = safeAbs(f['fileUrl'], origin);
    if (!url) continue;
    const res = rec(f['resolution']);
    const label = typeof res?.['label'] === 'string' ? res['label'].slice(0, 20) : '';
    const audioOnly = Number(res?.['id']) === 0;
    out.push({
      url,
      mediaType: audioOnly ? 'audio' : 'video',
      title: `${name}${label ? ` (${label})` : ''}`.slice(0, 200),
      ...(typeof f['height'] === 'number' && typeof f['width'] === 'number'
        ? { width: f['width'], height: f['height'] }
        : {}),
      ...(duration ? { durationSec: duration } : {}),
      ...(poster ? { poster } : {}),
    });
  }
  const playlists = Array.isArray(v['streamingPlaylists']) ? (v['streamingPlaylists'] as unknown[]) : [];
  for (const p of playlists.slice(0, 2)) {
    const url = safeAbs(rec(p)?.['playlistUrl'], origin);
    if (!url) continue;
    out.push({
      url,
      mimeType: 'application/vnd.apple.mpegurl',
      mediaType: 'video',
      title: name,
      ...(duration ? { durationSec: duration } : {}),
      ...(poster ? { poster } : {}),
    });
  }
  return out;
}
