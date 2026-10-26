import { describe, expect, it } from 'vitest';
import { activeTab, groupByFrame, imageMeetsMinimum, splitByTab, tabOf } from '@/lib/tabs';
import type { MediaResource } from '@/types/media';
import { makeResource } from './helpers';

let n = 0;
const r = (over: Partial<MediaResource> = {}) => makeResource(`https://example.com/f${n++}`, over);

describe('tabs', () => {
  it('puts each resource under the tab of its type', () => {
    expect(tabOf(r({ kind: 'file', mediaType: 'video' }))).toBe('video');
    expect(tabOf(r({ kind: 'hls-master', mediaType: 'video' }))).toBe('video');
    expect(tabOf(r({ kind: 'file', mediaType: 'unknown' }))).toBe('video');
    expect(tabOf(r({ kind: 'file', mediaType: 'audio' }))).toBe('audio');
    expect(tabOf(r({ kind: 'dash', mediaType: 'audio' }))).toBe('audio');
    expect(tabOf(r({ kind: 'subtitle' }))).toBe('subtitles');
    expect(tabOf(r({ kind: 'image' }))).toBe('images');
    expect(tabOf(r({ kind: 'document' }))).toBe('files');
    expect(tabOf(r({ kind: 'archive' }))).toBe('files');
    expect(tabOf(r({ kind: 'asset' }))).toBe('assets');
  });
  it('splits a list without losing or duplicating anything', () => {
    const list = [
      r({ id: 'a', kind: 'image' }),
      r({ id: 'b', kind: 'asset' }),
      r({ id: 'c' }),
      r({ id: 'd', kind: 'image' }),
    ];
    const split = splitByTab(list);
    expect(split.images.map((x) => x.id)).toEqual(['a', 'd']);
    expect(Object.values(split).flat()).toHaveLength(4);
  });
  it('keeps the chosen tab while it has items, otherwise the first that does', () => {
    const counts = { video: 0, audio: 0, subtitles: 2, images: 5, files: 0, assets: 1 };
    expect(activeTab(counts, 'images')).toBe('images');
    expect(activeTab(counts, 'files')).toBe('subtitles');
    expect(activeTab(counts, undefined)).toBe('subtitles');
    expect(activeTab({ video: 0, audio: 0, subtitles: 0, images: 0, files: 0, assets: 0 }, 'images')).toBe(
      'video',
    );
  });
  it('filters images by their shorter side and keeps those of unknown size', () => {
    expect(imageMeetsMinimum(r({ width: 800, height: 90 }), 100)).toBe(false);
    expect(imageMeetsMinimum(r({ width: 800, height: 400 }), 300)).toBe(true);
    expect(imageMeetsMinimum(r({ width: 99, height: 99 }), 100)).toBe(false);
    expect(imageMeetsMinimum(r({ width: 100, height: 100 }), 100)).toBe(true);
    expect(imageMeetsMinimum(r({}), 800)).toBe(true);
    expect(imageMeetsMinimum(r({ width: 1, height: 1 }), 0)).toBe(true);
  });
  it('groups by frame, top page first', () => {
    const groups = groupByFrame([
      r({ id: 'a', frameId: 3, frameUrl: 'https://embed.example/player?x=1' }),
      r({ id: 'b' }),
      r({ id: 'c', frameId: 0 }),
      r({ id: 'd', frameId: 3, frameUrl: 'https://embed.example/player?x=1' }),
      r({ id: 'e', frameId: 5, frameUrl: 'https://other.example/' }),
    ]);
    expect(groups.map((g) => [g.frameId, g.host, g.items.map((x) => x.id)])).toEqual([
      [0, '', ['b', 'c']],
      [3, 'embed.example', ['a', 'd']],
      [5, 'other.example', ['e']],
    ]);
  });
});
