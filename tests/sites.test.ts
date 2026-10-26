import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteLookupFor } from '@/lib/sites';
import { archiveLookup, parseArchive } from '@/lib/sites/archive';
import { commonsLookup, parseCommons } from '@/lib/sites/commons';
import { parsePeertube, peertubeLookup } from '@/lib/sites/peertube';

const sample = (name: string): unknown => JSON.parse(readFileSync(`tests/fixtures/sites/${name}`, 'utf8'));

describe('site recognition (by address only)', () => {
  it('finds the right adapter, and none for other addresses', () => {
    expect(siteLookupFor(new URL('https://commons.wikimedia.org/wiki/File:Example_clip.webm'))?.site).toBe(
      'commons',
    );
    expect(siteLookupFor(new URL('https://it.wikipedia.org/wiki/File:Clip.ogv'))?.site).toBe('commons');
    expect(siteLookupFor(new URL('https://archive.org/details/example_item'))?.site).toBe('archive');
    expect(siteLookupFor(new URL('https://peertube.example/w/kkGMgK9ZtnKfYAgnEtQxbv'))?.site).toBe(
      'peertube',
    );
    expect(
      siteLookupFor(new URL('https://peertube.example/videos/watch/9c9de5e8-0a1e-484a-b099-e80766180a6d'))
        ?.site,
    ).toBe('peertube');
    for (const other of [
      'https://www.youtube.com/watch?v=abc',
      'https://vimeo.com/123456',
      'https://example.com/',
      'https://evil.example/wiki/File:x.webm',
      'https://commons.wikimedia.org.evil.example/wiki/File:x.webm',
      'http://commons.wikimedia.org/wiki/File:x.webm',
      'https://commons.wikimedia.org/wiki/Category:Videos',
      'https://archive.org/search?query=x',
      'https://archive.org/details/../../x',
    ])
      expect(siteLookupFor(new URL(other)), other).toBeUndefined();
  });

  it("asks the page's own site, anonymously, with a fixed API address", () => {
    const c = commonsLookup(new URL('https://commons.wikimedia.org/wiki/File:Example_clip.webm?x=1#y'))!;
    const u = new URL(c.apiUrl);
    expect(u.origin).toBe('https://commons.wikimedia.org');
    expect(u.pathname).toBe('/w/api.php');
    expect(u.searchParams.get('titles')).toBe('File:Example clip.webm');
    expect(u.searchParams.get('action')).toBe('query');
    expect(archiveLookup(new URL('https://archive.org/details/example_item'))!.apiUrl).toBe(
      'https://archive.org/metadata/example_item',
    );
    expect(peertubeLookup(new URL('https://peertube.example/w/kkGMgK9ZtnKfYAgnEtQxbv'))!.apiUrl).toBe(
      'https://peertube.example/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv',
    );
  });
});

describe('Wikimedia Commons', () => {
  it('lists the original and its transcodes, with protocol-relative addresses resolved and unsafe ones dropped', () => {
    const r = parseCommons(
      sample('commons-video.json'),
      'https://commons.wikimedia.org/wiki/File:Example_clip.webm',
    );
    expect(r.map((m) => m.url)).toEqual([
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_clip.webm',
      'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Example_clip.webm/Example_clip.webm.480p.vp9.webm',
      'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Example_clip.webm/Example_clip.webm.360p.mp4',
    ]);
    expect(r[0]).toMatchObject({
      mediaType: 'video',
      mimeType: 'video/webm',
      title: 'Example clip',
      durationSec: 14.5,
      width: 1280,
      height: 720,
    });
    expect(r[2]).toMatchObject({ mimeType: 'video/mp4', title: 'Example clip (MP4 360P)', width: 640 });
  });
  it('offers nothing for images or unexpected answers', () => {
    expect(
      parseCommons(
        {
          query: {
            pages: [{ title: 'File:X.jpg', imageinfo: [{ url: 'https://u/x.jpg', mediatype: 'BITMAP' }] }],
          },
        },
        'https://commons.wikimedia.org/',
      ),
    ).toEqual([]);
    for (const junk of [
      null,
      5,
      'x',
      [],
      {},
      { query: {} },
      { query: { pages: 'no' } },
      { query: { pages: [{ missing: true }] } },
    ])
      expect(parseCommons(junk, 'https://commons.wikimedia.org/')).toEqual([]);
  });
});

describe('Internet Archive', () => {
  it('lists audio and video files (originals first) as download addresses; thumbnails, metadata and path tricks are left out', () => {
    const r = parseArchive(sample('archive-item.json'), 'example_item', 'https://archive.org');
    expect(r.map((m) => m.url)).toEqual([
      'https://archive.org/download/example_item/example_item.avi',
      'https://archive.org/download/example_item/example%20item.mp4',
      'https://archive.org/download/example_item/example_item.ogv',
      'https://archive.org/download/example_item/audio/part%201.mp3',
    ]);
    expect(r[0]).toMatchObject({
      mediaType: 'video',
      mimeType: 'video/x-msvideo',
      width: 720,
      height: 480,
      durationSec: 61.5,
    });
    expect(r[0]?.title).toBe('An Example Item · example_item.avi');
    expect(r[3]).toMatchObject({ mediaType: 'audio', durationSec: 30.25 });
  });
  it('caps the list and survives junk', () => {
    const files = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.mp4`, source: 'derivative' }));
    expect(parseArchive({ files }, 'x', 'https://archive.org')).toHaveLength(40);
    for (const junk of [null, 1, [], {}, { files: 'no' }, { files: [null, 5, { name: 7 }] }])
      expect(parseArchive(junk, 'x', 'https://archive.org')).toEqual([]);
  });
});

describe('PeerTube', () => {
  it('lists the web-video files from best to worst, and the HLS playlist', () => {
    const r = parsePeertube(sample('peertube-video.json'), 'https://peertube.example');
    expect(r.map((m) => m.url)).toEqual([
      'https://peertube.example/static/web-videos/9c9de5e8-720.mp4',
      'https://peertube.example/static/web-videos/9c9de5e8-360.mp4',
      'https://peertube.example/static/web-videos/9c9de5e8-0.m4a',
      'https://peertube.example/static/streaming-playlists/hls/9c9de5e8/master.m3u8',
    ]);
    expect(r[0]).toMatchObject({
      title: 'A PeerTube video (720p)',
      width: 1280,
      height: 720,
      durationSec: 125,
      poster: 'https://peertube.example/lazy-static/thumbnails/9c9de5e8.jpg',
    });
    expect(r[2]).toMatchObject({ mediaType: 'audio' });
    expect(r[3]).toMatchObject({ mimeType: 'application/vnd.apple.mpegurl' });
  });
  it('refuses answers that are not a PeerTube video, and live streams', () => {
    for (const junk of [
      null,
      'x',
      {},
      { uuid: 'a', files: [] },
      { uuid: 'a', name: 'n' },
      { uuid: 'a', name: 'n', files: [], isLive: true },
    ])
      expect(parsePeertube(junk, 'https://p.example')).toEqual([]);
  });
});
