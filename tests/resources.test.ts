import { describe, expect, it } from 'vitest';
import {
  dedupeResources,
  groupResources,
  hideCoveredVariants,
  mergeResource,
  resourceId,
} from '@/lib/resources';
import { makeResource } from './helpers';

describe('resourceId', () => {
  it('is stable across fragments, query order and default ports', () => {
    expect(resourceId('https://a.com/v.mp4?b=2&a=1#x')).toBe(resourceId('https://a.com:443/v.mp4?a=1&b=2'));
  });
  it('differs for different paths or query values', () => {
    expect(resourceId('https://a.com/v.mp4')).not.toBe(resourceId('https://a.com/w.mp4'));
    expect(resourceId('https://a.com/v.mp4?q=1')).not.toBe(resourceId('https://a.com/v.mp4?q=2'));
  });
});

describe('dedupeResources', () => {
  it('collapses duplicates and merges detection methods', () => {
    const a = makeResource('https://a.com/v.mp4', { detectedBy: ['dom-element'] });
    const b = makeResource('https://a.com/v.mp4#t=3', { detectedBy: ['performance'], sizeBytes: 1000 });
    const out = dedupeResources([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.detectedBy).toEqual(['dom-element', 'performance']);
    expect(out[0]?.sizeBytes).toBe(1000);
  });
  it('keeps resources that differ in URL', () => {
    expect(
      dedupeResources([makeResource('https://a.com/1.mp4'), makeResource('https://a.com/2.mp4')]),
    ).toHaveLength(2);
  });
  it('does not replace a resolved verdict with "not probed"', () => {
    const probed = makeResource('https://a.com/v.mp4', {
      downloadability: { status: 'downloadable', reason: 'ok' },
    });
    const raw = makeResource('https://a.com/v.mp4');
    expect(mergeResource(probed, raw).downloadability.status).toBe('downloadable');
  });
  it('keeps the earliest detection time', () => {
    const a = makeResource('https://a.com/v.mp4', { detectedAt: 500 });
    const b = makeResource('https://a.com/v.mp4', { detectedAt: 900 });
    expect(mergeResource(a, b).detectedAt).toBe(500);
  });
});

describe('grouping and covered variants', () => {
  it('groups by host and title', () => {
    const list = [
      makeResource('https://a.com/1.mp4', { title: 'Show' }),
      makeResource('https://a.com/2.mp4', { title: 'show' }),
      makeResource('https://b.com/3.mp4', { title: 'Show' }),
    ];
    expect(groupResources(list).map((g) => g.items.length)).toEqual([2, 1]);
  });
  it('hides variant playlists already offered by a master', () => {
    const variantUrl = 'https://a.com/720/index.m3u8';
    const master = makeResource('https://a.com/master.m3u8', {
      kind: 'hls-master',
      format: 'hls',
      variants: [{ uri: variantUrl, bandwidth: 1 }],
    });
    const variant = makeResource(variantUrl, { kind: 'hls-media', format: 'hls' });
    const other = makeResource('https://a.com/other.mp4');
    expect(hideCoveredVariants([master, variant, other]).map((r) => r.url)).toEqual([master.url, other.url]);
  });
});
