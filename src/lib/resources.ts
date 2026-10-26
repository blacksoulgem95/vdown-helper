import type { DetectionMethod, MediaResource } from '@/types/media';
import { parseDashRef } from './dash/ref';
import { normalizeUrl } from './security';

/** Stable, short id derived from the normalised URL (FNV-1a, 32-bit, hex). Not a security hash. */
export function resourceId(url: string): string {
  // A DASH representation (a subtitle track of a manifest) is a resource of its own: keep it apart from the manifest.
  const s = normalizeUrl(url) + (parseDashRef(url) ? `#${url.slice(url.indexOf('#vdh-rep=') + 1)}` : '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function mergeMethods(a: DetectionMethod[], b: DetectionMethod[]): DetectionMethod[] {
  return [...new Set([...a, ...b])];
}

/** Prefer the value that is present and more informative. */
function pick<T>(existing: T | undefined, incoming: T | undefined): T | undefined {
  return incoming ?? existing;
}

/**
 * Merge a newly probed resource into an existing one with the same id. Probed facts from the
 * incoming resource win; detection methods accumulate; the earliest detection time is kept.
 */
export function mergeResource(existing: MediaResource, incoming: MediaResource): MediaResource {
  const merged: MediaResource = {
    ...existing,
    ...incoming,
    detectedBy: mergeMethods(existing.detectedBy, incoming.detectedBy),
    detectedAt: Math.min(existing.detectedAt, incoming.detectedAt),
    variants: incoming.variants.length ? incoming.variants : existing.variants,
    audioTracks: incoming.audioTracks.length ? incoming.audioTracks : existing.audioTracks,
    // A resolved verdict is never replaced by "not probed".
    downloadability:
      incoming.downloadability.reason === 'not-probed' && existing.downloadability.reason !== 'not-probed'
        ? existing.downloadability
        : incoming.downloadability,
  };
  const optional = [
    'mimeType',
    'sizeBytes',
    'sizeIsEstimate',
    'durationSec',
    'width',
    'height',
    'bitrate',
    'frameRate',
    'codecs',
    'poster',
    'playlist',
    'language',
    'subtitleTracks',
    'ext',
  ] as const;
  for (const k of optional) {
    const v = pick(existing[k], incoming[k]);
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/** Deduplicate by id (normalised URL), merging duplicates. Order of first appearance is kept. */
export function dedupeResources(list: MediaResource[]): MediaResource[] {
  const map = new Map<string, MediaResource>();
  for (const r of list) {
    const prev = map.get(r.id);
    map.set(r.id, prev ? mergeResource(prev, r) : r);
  }
  return [...map.values()];
}

export interface ResourceGroup {
  key: string;
  title: string;
  host: string;
  items: MediaResource[];
}

/**
 * Group related resources: a master playlist and its variant playlists/files that share a title and host
 * are shown together. Resources without a sibling form their own group.
 */
export function groupResources(list: MediaResource[]): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>();
  for (const r of list) {
    const key = `${r.host}::${r.title.toLowerCase()}`;
    const g = groups.get(key) ?? { key, title: r.title, host: r.host, items: [] };
    g.items.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * When a master playlist is present, its own variant URLs (found separately via the Performance API or
 * network observer) are hidden: the master already offers them as selectable qualities.
 */
export function hideCoveredVariants(list: MediaResource[]): MediaResource[] {
  const covered = new Set<string>();
  for (const r of list) {
    if (r.kind === 'hls-master') {
      for (const v of r.variants) covered.add(resourceId(v.uri));
      for (const a of r.audioTracks) if (a.uri) covered.add(resourceId(a.uri));
      for (const s of r.subtitleTracks ?? []) if (s.uri) covered.add(resourceId(s.uri));
    }
  }
  // Subtitle playlists are listed by their manifest on purpose: they are shown as subtitles, not hidden as variants.
  return list.filter((r) => r.kind === 'hls-master' || r.kind === 'subtitle' || !covered.has(r.id));
}

/** Tallest picture a resource offers: its own, or the best of its variants. */
export const bestHeight = (r: MediaResource): number =>
  Math.max(r.height ?? 0, ...r.variants.map((v) => v.height ?? 0));

/** What one click on the card does: a real file beats a capture, which beats a recording; refused comes last. */
function actionRank(r: MediaResource): number {
  if (r.downloadability.status !== 'downloadable') return 0;
  const d = r.downloadability.detail;
  if (d === 'stream-recordable' || d === 'live-recordable') return 1;
  if (d === 'mse-capturable') return 2;
  return 3;
}

const mediaRank = (r: MediaResource): number =>
  r.mediaType === 'video' ? 2 : r.mediaType === 'unknown' ? 1 : 0;

/**
 * The order the user most likely wants: what can be saved with one click first, then video over audio, the highest
 * quality, the longest, the page itself before embedded frames; detection order breaks the remaining ties.
 */
export function rankResources(list: readonly MediaResource[]): MediaResource[] {
  return list
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        actionRank(b.r) - actionRank(a.r) ||
        mediaRank(b.r) - mediaRank(a.r) ||
        bestHeight(b.r) - bestHeight(a.r) ||
        (b.r.durationSec ?? 0) - (a.r.durationSec ?? 0) ||
        Number((a.r.frameId ?? 0) !== 0) - Number((b.r.frameId ?? 0) !== 0) ||
        a.i - b.i,
    )
    .map((x) => x.r);
}

/** The card worth putting first: only when there is a choice to make and the top one can actually be saved. */
export function bestMatch(ranked: readonly MediaResource[]): MediaResource | undefined {
  const top = ranked[0];
  return ranked.length >= 2 && top && actionRank(top) > 0 ? top : undefined;
}
