import type { MediaResource } from '@/types/media';
import { parseUrl } from './security';

export type TabKey = 'video' | 'audio' | 'subtitles' | 'images' | 'files' | 'assets';

export const TAB_ORDER: readonly TabKey[] = ['video', 'audio', 'subtitles', 'images', 'files', 'assets'];

/** The popup tab a resource is listed under. */
export function tabOf(r: MediaResource): TabKey {
  switch (r.kind) {
    case 'subtitle':
      return 'subtitles';
    case 'image':
      return 'images';
    case 'document':
    case 'archive':
      return 'files';
    case 'asset':
      return 'assets';
    default:
      return r.mediaType === 'audio' ? 'audio' : 'video';
  }
}

export const isFileTab = (t: TabKey): boolean => t === 'images' || t === 'files' || t === 'assets';

export function splitByTab(resources: readonly MediaResource[]): Record<TabKey, MediaResource[]> {
  const out: Record<TabKey, MediaResource[]> = {
    video: [],
    audio: [],
    subtitles: [],
    images: [],
    files: [],
    assets: [],
  };
  for (const r of resources) out[tabOf(r)].push(r);
  return out;
}

/** The first tab that has something in it, or the preferred one while it still does. */
export function activeTab(counts: Record<TabKey, number>, preferred: TabKey | undefined): TabKey {
  if (preferred && counts[preferred] > 0) return preferred;
  return TAB_ORDER.find((k) => counts[k] > 0) ?? 'video';
}

/**
 * Images below the size filter. The shorter side decides, so a banner is not hidden for being short. An image whose
 * size is unknown (CSS backgrounds, images that have not loaded) is kept: hiding it would be a guess.
 */
export function imageMeetsMinimum(r: MediaResource, minPx: number): boolean {
  if (minPx <= 0 || !r.width || !r.height) return true;
  return Math.min(r.width, r.height) >= minPx;
}

export interface FrameGroup {
  /** 0 for the top page. */
  frameId: number;
  /** Host of the frame's document; empty for the top page. */
  host: string;
  items: MediaResource[];
}

/** Items grouped by the frame they were found in, top page first, then in order of first appearance. */
export function groupByFrame(items: readonly MediaResource[]): FrameGroup[] {
  const groups = new Map<number, FrameGroup>();
  for (const r of items) {
    const id = r.frameId ?? 0;
    let g = groups.get(id);
    if (!g) {
      g = { frameId: id, host: id === 0 ? '' : (parseUrl(r.frameUrl ?? '')?.host ?? ''), items: [] };
      groups.set(id, g);
    }
    g.items.push(r);
  }
  return [...groups.values()].sort((a, b) => Number(b.frameId === 0) - Number(a.frameId === 0));
}
