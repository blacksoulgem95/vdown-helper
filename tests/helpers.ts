import type { MediaResource } from '@/types/media';
import { resourceId } from '@/lib/resources';

export function makeResource(url: string, over: Partial<MediaResource> = {}): MediaResource {
  const u = new URL(url);
  return {
    id: resourceId(url),
    url,
    tabId: 1,
    pageUrl: 'https://example.com/page',
    pageTitle: 'Example page',
    host: u.hostname,
    title: 'Clip',
    kind: 'file',
    format: 'mp4',
    mediaType: 'video',
    detectedBy: ['dom-element'],
    downloadability: { status: 'unknown', reason: 'not-probed' },
    variants: [],
    audioTracks: [],
    detectedAt: 1000,
    ...over,
  };
}
