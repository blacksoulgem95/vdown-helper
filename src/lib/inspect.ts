import type { HlsMediaPlaylist } from '@/types/hls';
import type { VariantInspection } from '@/types/messages';
import type { DashManifest, DashPeriod, DashRepresentation } from '@/types/dash';
import { expandSegments, protectionsOf } from './dash/parser';
import { extensionOf } from './media';
import { parseUrl } from './security';

/** Origins (scheme + host) that a download of this playlist will contact. Used for access checks. */
export function originsOf(urls: Iterable<string>, max = 24): string[] {
  const set = new Set<string>();
  for (const u of urls) {
    const o = parseUrl(u);
    if (o && (o.protocol === 'https:' || o.protocol === 'http:')) set.add(o.origin);
    if (set.size >= max) break;
  }
  return [...set];
}

export function sampleByOrigin(urls: Iterable<string>, max = 24): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of urls) {
    const o = parseUrl(u);
    if (o && (o.protocol === 'https:' || o.protocol === 'http:') && !(o.origin in out)) out[o.origin] = u;
    if (Object.keys(out).length >= max) break;
  }
  return out;
}

export function inspectMediaPlaylist(p: HlsMediaPlaylist): VariantInspection {
  const urls = new Set<string>([p.url]);
  const keyUris = new Set<string>();
  for (const s of p.segments) {
    urls.add(s.uri);
    if (s.map) urls.add(s.map.uri);
    if (s.key?.uri && s.key.method === 'AES-128' && !s.key.protectedByDrm) {
      keyUris.add(s.key.uri);
      urls.add(s.key.uri);
    }
  }
  const out: VariantInspection = {
    url: p.url,
    segmentCount: p.segments.length,
    durationSec: p.totalDuration,
    live: !p.endList,
    fragmented: p.fragmented,
    encryption: p.encryption,
    protectedByDrm: p.hasDrm,
    keyUris: [...keyUris],
    origins: originsOf(urls),
    originSamples: sampleByOrigin(urls),
    firstSegmentExt: extensionOf(p.segments[0]?.uri ?? '') || (p.fragmented ? 'm4s' : 'ts'),
  };
  if (p.targetDuration !== undefined) out.targetDuration = p.targetDuration;
  return out;
}

/** Summary of one DASH representation, shaped like the HLS one so the rest of the app treats them alike. */
export function inspectDashRepresentation(
  m: DashManifest,
  period: DashPeriod,
  rep: DashRepresentation,
): VariantInspection {
  const e = expandSegments(m, period, rep);
  const urls = new Set<string>([m.url, ...e.segments.map((s) => s.uri)]);
  if (e.init) urls.add(e.init.uri);
  // A subtitle track is separate clear text even when the video of the same stream is encrypted.
  const prot = protectionsOf(rep.content === 'text' ? [rep] : period.representations);
  return {
    url: m.url,
    segmentCount: e.segments.length,
    durationSec: e.durationSec,
    live: m.type === 'dynamic',
    fragmented: true,
    encryption: prot.systems.length > 0 ? prot.systems.map((x) => x.toUpperCase()) : [],
    // ClearKey is not DRM but its key cannot be obtained yet, so it is refused the same way.
    protectedByDrm: prot.drm || prot.clearKey,
    keyUris: [],
    origins: originsOf(urls),
    originSamples: sampleByOrigin(urls),
    firstSegmentExt: extensionOf(e.segments[0]?.uri ?? '') || 'm4s',
  };
}
