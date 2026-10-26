import { describe, expect, it } from 'vitest';
import {
  mediaFromFeed,
  mediaFromJsonLd,
  mediaFromLinks,
  mediaFromMetaTags,
  safeAbs,
  type MetaTag,
} from '@/lib/metadata';

const BASE = 'https://example.com/post/1';
const tag = (key: string, content: string): MetaTag => ({ key, content });

describe('safeAbs', () => {
  it('resolves relative addresses and keeps only http(s)', () => {
    expect(safeAbs('/v/a.mp4', BASE)).toBe('https://example.com/v/a.mp4');
    expect(safeAbs('//cdn.example/x.mp4', BASE)).toBe('https://cdn.example/x.mp4');
    for (const bad of [
      'javascript:alert(1)',
      'data:video/mp4;base64,AAAA',
      'blob:https://x/y',
      'file:///etc/passwd',
      '',
      '  ',
      42,
      undefined,
    ])
      expect(safeAbs(bad, BASE)).toBeUndefined();
    expect(safeAbs(`https://example.com/${'a'.repeat(3000)}`, BASE)).toBeUndefined();
  });
});

describe('Open Graph and Twitter tags', () => {
  it('reads og:video with its type and size, og:audio, and the title and image of the page', () => {
    const r = mediaFromMetaTags(
      [
        tag('og:title', 'A clip'),
        tag('og:image', '/p.jpg'),
        tag('og:video', 'https://cdn.example/a.mp4'),
        tag('og:video:secure_url', 'https://cdn.example/a.mp4'),
        tag('og:video:type', 'video/mp4'),
        tag('og:video:width', '1280'),
        tag('og:video:height', '720'),
        tag('og:audio', '/a.mp3'),
      ],
      BASE,
    );
    expect(r).toEqual([
      {
        url: 'https://cdn.example/a.mp4',
        mimeType: 'video/mp4',
        mediaType: 'video',
        title: 'A clip',
        poster: 'https://example.com/p.jpg',
        width: 1280,
        height: 720,
      },
      {
        url: 'https://example.com/a.mp3',
        mediaType: 'audio',
        title: 'A clip',
        poster: 'https://example.com/p.jpg',
      },
    ]);
  });

  it('does not take an embed page for a file, and drops unsafe addresses', () => {
    expect(
      mediaFromMetaTags(
        [
          tag('og:video', 'https://player.example/embed/1'),
          tag('og:video:type', 'text/html'),
          tag('og:video:url', 'javascript:alert(1)'),
        ],
        BASE,
      ),
    ).toEqual([]);
    expect(
      mediaFromMetaTags(
        [tag('og:video', 'https://x.example/f.swf'), tag('og:video:type', 'application/x-shockwave-flash')],
        BASE,
      ),
    ).toEqual([]);
  });

  it('uses twitter:player:stream', () => {
    const r = mediaFromMetaTags(
      [
        tag('twitter:player:stream', 'https://cdn.example/s.m3u8'),
        tag('twitter:player:stream:content_type', 'application/x-mpegURL'),
      ],
      BASE,
    );
    expect(r).toMatchObject([{ url: 'https://cdn.example/s.m3u8', mediaType: 'video' }]);
  });
});

describe('JSON-LD', () => {
  it('reads contentUrl of VideoObject / AudioObject, including inside @graph, and never embedUrl', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'ignore', contentUrl: 'https://example.com/not-media' },
        {
          '@type': 'VideoObject',
          name: 'Launch',
          contentUrl: '/launch.mp4',
          embedUrl: 'https://example.com/embed/launch',
          duration: 'PT1M30S',
          encodingFormat: 'video/mp4',
          thumbnailUrl: ['https://example.com/t.jpg'],
          width: 1920,
          height: '1080',
        },
        {
          '@type': ['Thing', 'AudioObject'],
          name: 'Jingle',
          contentUrl: ['https://example.com/j.mp3', 'javascript:1'],
        },
      ],
    });
    expect(mediaFromJsonLd(ld, BASE)).toEqual([
      {
        url: 'https://example.com/launch.mp4',
        mimeType: 'video/mp4',
        mediaType: 'video',
        title: 'Launch',
        durationSec: 90,
        width: 1920,
        height: 1080,
        poster: 'https://example.com/t.jpg',
      },
      { url: 'https://example.com/j.mp3', mediaType: 'audio', title: 'Jingle' },
    ]);
  });

  it('survives garbage, deep nesting and huge input', () => {
    expect(mediaFromJsonLd('not json', BASE)).toEqual([]);
    expect(mediaFromJsonLd('null', BASE)).toEqual([]);
    expect(mediaFromJsonLd('x'.repeat(2_000_000), BASE)).toEqual([]);
    let deep: unknown = { '@type': 'VideoObject', contentUrl: 'https://example.com/deep.mp4' };
    for (let i = 0; i < 30; i++) deep = { mainEntity: deep };
    expect(mediaFromJsonLd(JSON.stringify(deep), BASE)).toEqual([]);
  });
});

describe('<link rel="alternate">', () => {
  it('separates media files from feeds, and ignores every other alternate', () => {
    const r = mediaFromLinks(
      [
        { rel: 'alternate', type: 'video/mp4', href: '/v.mp4', title: 'MP4' },
        { rel: 'alternate', type: 'application/vnd.apple.mpegurl', href: '/v.m3u8' },
        { rel: 'alternate', type: 'application/rss+xml', href: '/feed.xml' },
        { rel: 'alternate', type: 'text/html', href: '/fr/' },
        { rel: 'stylesheet', type: 'video/mp4', href: '/not.mp4' },
        { rel: 'alternate stylesheet', type: 'application/atom+xml', href: 'javascript:1' },
      ],
      BASE,
    );
    expect(r.media.map((m) => m.url)).toEqual(['https://example.com/v.mp4', 'https://example.com/v.m3u8']);
    expect(r.media[0]).toMatchObject({ mediaType: 'video', title: 'MP4' });
    expect(r.feeds).toEqual(['https://example.com/feed.xml']);
  });
});

describe('podcast feeds', () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title>
    <item><title>Episode 1</title><itunes:duration>1:02:03</itunes:duration><enclosure url="https://cdn.example/e1.mp3" length="123" type="audio/mpeg"/></item>
    <item><title>Episode 2 &amp; more</title><itunes:duration>300</itunes:duration><enclosure url="/e2.m4a" type=""/></item>
    <item><title>Cover</title><enclosure url="https://cdn.example/cover.jpg" type="image/jpeg"/></item>
    <item><title>Bad</title><enclosure url="javascript:alert(1)" type="audio/mpeg"/></item>
    <item><title>Video</title><enclosure url="https://cdn.example/v.mp4" type="video/mp4"/></item>
  </channel></rss>`;
  it('lists audio and video enclosures with title and duration', () => {
    expect(mediaFromFeed(RSS, 'https://example.com/feed.xml')).toEqual([
      {
        url: 'https://cdn.example/e1.mp3',
        mimeType: 'audio/mpeg',
        mediaType: 'audio',
        title: 'Episode 1',
        durationSec: 3723,
      },
      { url: 'https://example.com/e2.m4a', mediaType: 'audio', title: 'Episode 2 & more', durationSec: 300 },
      { url: 'https://cdn.example/v.mp4', mimeType: 'video/mp4', mediaType: 'video', title: 'Video' },
    ]);
  });
  it('reads Atom enclosure links and ignores broken or oversized documents', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>One</title><link rel="enclosure" href="https://cdn.example/1.ogg" type="audio/ogg"/><link rel="alternate" href="https://x"/></entry></feed>`;
    expect(mediaFromFeed(atom, BASE)).toMatchObject([
      { url: 'https://cdn.example/1.ogg', mediaType: 'audio', title: 'One' },
    ]);
    expect(mediaFromFeed('<rss><channel>', BASE)).toEqual([]);
    expect(mediaFromFeed('x'.repeat(3_000_000), BASE)).toEqual([]);
  });
});
