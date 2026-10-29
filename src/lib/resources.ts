/** Resource ids, merging, grouping and ranking. Implemented in Rust (`core/src/resources.rs`). */
import type { MediaResource } from '@/types/media';
import { core } from './core';

/** Stable, short id derived from the normalised URL (FNV-1a, 32-bit, hex). Not a security hash. */
export function resourceId(url: string): string {
  return core.resourceId(url);
}

/**
 * Merge a newly probed resource into an existing one with the same id. Probed facts from the
 * incoming resource win; detection methods accumulate; the earliest detection time is kept.
 */
export function mergeResource(existing: MediaResource, incoming: MediaResource): MediaResource {
  return core.mergeResource(existing, incoming) as MediaResource;
}

/** Deduplicate by id (normalised URL), merging duplicates. Order of first appearance is kept. */
export function dedupeResources(list: MediaResource[]): MediaResource[] {
  return core.dedupeResources(list) as MediaResource[];
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
  const groups = core.groupIndexes(list) as Array<Omit<ResourceGroup, 'items'> & { items: number[] }>;
  return groups.map((g) => ({ ...g, items: g.items.map((i) => list[i] as MediaResource) }));
}

/**
 * When a master playlist is present, its own variant URLs (found separately via the Performance API or
 * network observer) are hidden: the master already offers them as selectable qualities.
 */
export function hideCoveredVariants(list: MediaResource[]): MediaResource[] {
  return [...core.visibleIndexes(list)].map((i) => list[i] as MediaResource);
}

/** Tallest picture a resource offers: its own, or the best of its variants. */
export const bestHeight = (r: MediaResource): number => core.bestHeight(r);

/**
 * The order the user most likely wants: what can be saved with one click first, then video over audio, the highest
 * quality, the longest, the page itself before embedded frames; detection order breaks the remaining ties.
 */
export function rankResources(list: readonly MediaResource[]): MediaResource[] {
  return [...core.rankOrder(list)].map((i) => list[i] as MediaResource);
}

/** The card worth putting first: only when there is a choice to make and the top one can actually be saved. */
export function bestMatch(ranked: readonly MediaResource[]): MediaResource | undefined {
  const top = ranked[0];
  return ranked.length >= 2 && top && core.actionRank(top) > 0 ? top : undefined;
}
