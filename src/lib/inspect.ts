import type { HlsMediaPlaylist } from '@/types/hls';
import type { VariantInspection } from '@/types/messages';
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
    firstSegmentExt: extensionOf(p.segments[0]?.uri ?? '') || (p.fragmented ? 'm4s' : 'ts'),
  };
  if (p.targetDuration !== undefined) out.targetDuration = p.targetDuration;
  return out;
}
