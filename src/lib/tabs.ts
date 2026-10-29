/** How the popup lists resources. Implemented in Rust (`core/src/tabs.rs`). */
import type { MediaResource } from '@/types/media';
import { core } from './core';

export type TabKey = 'video' | 'audio' | 'subtitles' | 'images' | 'files' | 'assets';

export const TAB_ORDER: readonly TabKey[] = ['video', 'audio', 'subtitles', 'images', 'files', 'assets'];

/** The popup tab a resource is listed under. */
export function tabOf(r: MediaResource): TabKey {
  return core.tabOf(r) as TabKey;
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
  core.tabsOf(resources).forEach((tab, i) => out[tab as TabKey].push(resources[i] as MediaResource));
  return out;
}

/** The first tab that has something in it, or the preferred one while it still does. */
export function activeTab(counts: Record<TabKey, number>, preferred: TabKey | undefined): TabKey {
  return core.activeTab(counts, preferred) as TabKey;
}

/**
 * Images below the size filter. The shorter side decides, so a banner is not hidden for being short. An image whose
 * size is unknown (CSS backgrounds, images that have not loaded) is kept: hiding it would be a guess.
 */
export function imageMeetsMinimum(r: MediaResource, minPx: number): boolean {
  return core.imageMeetsMinimum(r, minPx);
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
  const groups = core.frameGroups(items) as Array<{ frameId: number; host: string; items: number[] }>;
  return groups.map((g) => ({ ...g, items: g.items.map((i) => items[i] as MediaResource) }));
}

/** Why the popup has nothing to offer, which decides the one button the empty state shows. */
export type EmptyCause = 'error' | 'blocked-frames' | 'reload' | 'nothing';

export function emptyCause(o: { error: boolean; blockedFrames: number; reloadPending: boolean }): EmptyCause {
  return core.emptyCause(o.error, o.blockedFrames, o.reloadPending) as EmptyCause;
}
