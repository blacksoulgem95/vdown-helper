import { beforeEach, describe, expect, it } from 'vitest';
import { addManual, getManual, manualUrl } from '@/background/manual';
import { installFakeChrome } from './helpers/fake-chrome';

beforeEach(() => void installFakeChrome());

describe('links pasted by hand (VDH-054)', () => {
  it('accepts http(s) links, including CDN paths with commas, and refuses other schemes', () => {
    const cdn = 'https://cdn.example/hls/aaa,bbb,ccc,.urlset/master.m3u8';
    expect(manualUrl(`  ${cdn}  `)).toBe(cdn);
    expect(manualUrl('http://cdn.example/list.m3u')).toBe('http://cdn.example/list.m3u');
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'blob:https://a.example/x',
      'data:text/plain,x',
      'nope',
    ])
      expect(manualUrl(bad)).toBeUndefined();
  });
  it('remembers links per tab, once each, and hands them to the scan', async () => {
    await addManual(3, 'https://cdn.example/a.m3u8');
    await addManual(3, 'https://cdn.example/a.m3u8');
    await addManual(3, 'https://cdn.example/b.mpd');
    await addManual(4, 'https://cdn.example/c.mp4');
    expect(await getManual(3)).toEqual([
      { url: 'https://cdn.example/a.m3u8', method: 'manual-rescan' },
      { url: 'https://cdn.example/b.mpd', method: 'manual-rescan' },
    ]);
    expect((await getManual(4)).map((c) => c.url)).toEqual(['https://cdn.example/c.mp4']);
  });
  it('keeps at most 20 per tab, the latest ones', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => addManual(5, `https://cdn.example/${i}.m3u8`)));
    const list = await getManual(5);
    expect(list).toHaveLength(20);
    expect(list.at(-1)?.url).toBe('https://cdn.example/24.m3u8');
  });
});
