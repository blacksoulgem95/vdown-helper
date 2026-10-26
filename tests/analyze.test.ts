import { describe, expect, it } from 'vitest';
import { analyzeCandidates, type Fetcher } from '@/lib/analyze';
import type { ProbeResult } from '@/lib/netprobe';
import type { RawCandidate } from '@/types/media';
import { AES, DASH, LIVE, MASTER, MEDIA, PLAIN_M3U, SAMPLE_AES } from './fixtures/hls';

const ctx = { tabId: 1, pageUrl: 'https://site.example/watch', pageTitle: 'Watch page', now: 1 };

const okText = (
  text: string,
  finalUrl: string,
  contentType = 'application/vnd.apple.mpegurl',
): ProbeResult => ({
  ok: true,
  status: 200,
  contentType,
  acceptRanges: false,
  finalUrl,
  text,
});
const okHead = (contentType: string, contentLength?: number): ProbeResult => ({
  ok: true,
  status: 200,
  contentType,
  acceptRanges: true,
  finalUrl: '',
  ...(contentLength ? { contentLength } : {}),
});

function fetcher(map: Record<string, ProbeResult>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const get = async (url: string): Promise<ProbeResult> => {
    calls.push(url);
    return map[url] ?? { ok: false, kind: 'http', status: 404 };
  };
  return { calls, head: get, text: get };
}

const cand = (url: string, extra: Partial<RawCandidate> = {}): RawCandidate => ({
  url,
  method: 'dom-element',
  ...extra,
});

describe('direct files', () => {
  it('reports size and type from headers', async () => {
    const f = fetcher({ 'https://cdn.example/a.mp4': okHead('video/mp4', 5_000_000) });
    const [r] = await analyzeCandidates(
      [cand('https://cdn.example/a.mp4', { durationSec: 90, width: 1280, height: 720 })],
      ctx,
      f,
    );
    expect(r).toMatchObject({
      kind: 'file',
      format: 'mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5_000_000,
      durationSec: 90,
      height: 720,
      host: 'site.example',
      downloadability: { status: 'downloadable', reason: 'ok' },
    });
    expect(r?.sizeIsEstimate).toBeUndefined();
  });
  it('is still downloadable (natively) when headers are blocked by CORS, with unknown size', async () => {
    const f = fetcher({ 'https://cdn.example/a.mp4': { ok: false, kind: 'blocked' } });
    const [r] = await analyzeCandidates([cand('https://cdn.example/a.mp4')], ctx, f);
    expect(r?.downloadability).toMatchObject({ status: 'downloadable', detail: 'headers-unreadable' });
    expect(r?.sizeBytes).toBeUndefined();
  });
  it('marks HTTP errors as inaccessible', async () => {
    const f = fetcher({ 'https://cdn.example/a.mp4': { ok: false, kind: 'http', status: 403 } });
    const [r] = await analyzeCandidates([cand('https://cdn.example/a.mp4')], ctx, f);
    expect(r?.downloadability).toEqual({ status: 'inaccessible', reason: 'http-error', detail: 'HTTP 403' });
  });
  it('detects an HLS playlist served without an extension', async () => {
    const url = 'https://cdn.example/stream?id=7';
    const f = fetcher({ [url]: okText(MEDIA, url) });
    const [r] = await analyzeCandidates([cand(url)], ctx, f);
    expect(r?.format).toBe('hls');
    expect(r?.kind).toBe('hls-media');
  });
  it('rejects non-media documents found through links', async () => {
    const f = fetcher({ 'https://cdn.example/x': okHead('text/html') });
    const [r] = await analyzeCandidates([cand('https://cdn.example/x', { method: 'dom-link' })], ctx, f);
    expect(r?.downloadability).toMatchObject({ status: 'unsupported', reason: 'unsupported-format' });
  });
  it('ignores unsafe URLs entirely', async () => {
    const f = fetcher({});
    expect(await analyzeCandidates([cand('javascript:alert(1)'), cand('file:///x.mp4')], ctx, f)).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it('deduplicates the same media seen by several detection methods', async () => {
    const f = fetcher({ 'https://cdn.example/a.mp4': okHead('video/mp4', 10) });
    const out = await analyzeCandidates(
      [cand('https://cdn.example/a.mp4'), cand('https://cdn.example/a.mp4#t=1', { method: 'performance' })],
      ctx,
      f,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.detectedBy).toEqual(['dom-element', 'performance']);
    expect(f.calls).toHaveLength(1);
  });
});

describe('HLS', () => {
  const MASTER_URL = 'https://cdn.example/master.m3u8';
  const V1080 = 'https://cdn.example.com/1080p/index.m3u8?token=abc';
  it('parses a master playlist, exposes only real variants and estimates size from bandwidth', async () => {
    const f = fetcher({ [MASTER_URL]: okText(MASTER, MASTER_URL), [V1080]: okText(MEDIA, V1080) });
    const [r] = await analyzeCandidates([cand(MASTER_URL)], ctx, f);
    expect(r?.kind).toBe('hls-master');
    expect(r?.variants.map((v) => v.height)).toEqual([1080, 720, 360]);
    expect(r?.audioTracks).toHaveLength(2);
    expect(r).toMatchObject({
      height: 1080,
      width: 1920,
      frameRate: 30,
      downloadability: { status: 'downloadable' },
    });
    expect(r?.durationSec).toBeCloseTo(21.021, 2);
    expect(r?.sizeIsEstimate).toBe(true);
    expect(r?.sizeBytes).toBe(Math.round((2_800_000 * 21.021) / 8));
    expect(r?.playlist).toMatchObject({ playlistClass: 'hls-master', segmentCount: 3, live: false });
  });
  it('is inaccessible (not "broken") when the playlist is CORS-blocked', async () => {
    const f = fetcher({ [MASTER_URL]: { ok: false, kind: 'blocked' } });
    const [r] = await analyzeCandidates([cand(MASTER_URL)], ctx, f);
    expect(r?.downloadability).toEqual({ status: 'inaccessible', reason: 'cors' });
  });
  it('is inaccessible when the first variant playlist cannot be read', async () => {
    const f = fetcher({ [MASTER_URL]: okText(MASTER, MASTER_URL) });
    const [r] = await analyzeCandidates([cand(MASTER_URL)], ctx, f);
    expect(r?.downloadability).toMatchObject({
      status: 'inaccessible',
      reason: 'http-error',
      detail: 'variant-playlist',
    });
  });
  it.each([
    ['AES-128 is downloadable', AES, 'downloadable', 'ok'],
    ['SAMPLE-AES is protected', SAMPLE_AES, 'protected', 'sample-aes'],
    ['live streams can be recorded, not downloaded', LIVE, 'downloadable', 'ok'],
  ])('media playlist: %s', async (_n, text, status, reason) => {
    const url = 'https://cdn.example/p.m3u8';
    const [r] = await analyzeCandidates([cand(url)], ctx, fetcher({ [url]: okText(text, url) }));
    expect(r?.downloadability).toMatchObject({ status, reason });
    if (text === LIVE) expect(r?.downloadability.detail).toBe('live-recordable');
  });
  it('separates plain M3U, DASH and malformed playlists from HLS', async () => {
    const out = await analyzeCandidates(
      [
        cand('https://cdn.example/list.m3u'),
        cand('https://cdn.example/m.mpd'),
        cand('https://cdn.example/bad.m3u8'),
      ],
      ctx,
      fetcher({
        'https://cdn.example/list.m3u': okText(PLAIN_M3U, 'https://cdn.example/list.m3u', 'audio/x-mpegurl'),
        'https://cdn.example/m.mpd': okText(DASH, 'https://cdn.example/m.mpd', 'application/dash+xml'),
        'https://cdn.example/bad.m3u8': okText(
          '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1x1\nx\n',
          'https://cdn.example/bad.m3u8',
        ),
      }),
    );
    const by = Object.fromEntries(out.map((r) => [new URL(r.url).pathname, r.downloadability]));
    expect(by['/list.m3u']).toMatchObject({ status: 'unsupported', reason: 'plain-m3u' });
    // an MPD with no periods is a malformed DASH manifest (real ones are covered by the DASH tests below)
    expect(by['/m.mpd']).toMatchObject({ status: 'unsupported', reason: 'malformed' });
    expect(by['/bad.m3u8']).toMatchObject({ status: 'unsupported', reason: 'malformed' });
  });
  it('hides variant playlists that a master already offers', async () => {
    const f = fetcher({ [MASTER_URL]: okText(MASTER, MASTER_URL), [V1080]: okText(MEDIA, V1080) });
    const out = await analyzeCandidates([cand(V1080, { method: 'performance' }), cand(MASTER_URL)], ctx, f);
    // the master's own subtitle rendition is listed too, as a subtitle (see tests/subtitle-analyze.test.ts)
    expect(out.map((r) => r.kind).filter((k) => k !== 'subtitle')).toEqual(['hls-master']);
  });
});

describe('DASH', () => {
  const MPD_URL = 'https://cdn.example/show/manifest.mpd';
  const mpd = (
    extra = '',
    attrs = 'type="static" mediaPresentationDuration="PT20S"',
  ) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrs}><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">${extra}
    <SegmentTemplate timescale="1000" duration="4000" initialization="v/$RepresentationID$/i.mp4" media="v/$RepresentationID$/$Number$.m4s"/>
    <Representation id="720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
    <Representation id="360" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e"/>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en"><SegmentTemplate timescale="1000" duration="4000" initialization="a/i.mp4" media="a/$Number$.m4s"/>
    <Representation id="aud" bandwidth="128000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
  const run = async (text: string, mime = 'application/dash+xml') => {
    const f = fetcher({ [MPD_URL]: okText(text, MPD_URL, mime) });
    return (await analyzeCandidates([cand(MPD_URL)], ctx, f))[0]!;
  };

  it('lists only the real representations, best first, with separate audio and an estimated size', async () => {
    const r = await run(mpd());
    expect(r.kind).toBe('dash');
    expect(r.format).toBe('dash');
    expect(r.variants.map((v) => [v.height, v.bandwidth, v.audioGroup])).toEqual([
      [720, 2_000_000, 'dash-audio'],
      [360, 800_000, 'dash-audio'],
    ]);
    expect(r.variants[0]!.uri).toBe(`${MPD_URL}#vdh-rep=720`);
    expect(r.audioTracks.map((a) => [a.name, a.language, a.uri])).toEqual([
      ['en', 'en', `${MPD_URL}#vdh-rep=aud`],
    ]);
    expect(r).toMatchObject({
      durationSec: 20,
      height: 720,
      downloadability: { status: 'downloadable', reason: 'ok' },
      sizeIsEstimate: true,
    });
    expect(r.sizeBytes).toBe(Math.round((2_000_000 * 20) / 8));
    expect(r.playlist).toMatchObject({
      playlistClass: 'dash',
      segmentCount: 5,
      live: false,
      fragmented: true,
      periods: 1,
    });
  });
  it('is recognised by content, not just by file name', async () => {
    const f = fetcher({
      'https://cdn.example/stream?id=9': okText(
        mpd(),
        'https://cdn.example/stream?id=9',
        'application/dash+xml',
      ),
    });
    const [r] = await analyzeCandidates(
      [cand('https://cdn.example/stream?id=9', { mimeType: 'application/dash+xml' })],
      ctx,
      f,
    );
    expect(r?.kind).toBe('dash');
  });
  it('refuses Widevine / PlayReady manifests as protected', async () => {
    const r = await run(
      mpd('<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'),
    );
    expect(r.downloadability).toMatchObject({ status: 'protected', reason: 'drm' });
    expect(r.downloadability.detail).toContain('widevine');
  });
  it('does not call ClearKey DRM, but cannot download it until its key is obtainable', async () => {
    const r = await run(
      mpd('<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"/>'),
    );
    expect(r.downloadability).toMatchObject({ status: 'unsupported', reason: 'dash-clearkey' });
  });
  it('live (dynamic) manifests can be recorded, not downloaded', async () => {
    const r = await run(mpd('', 'type="dynamic" minimumUpdatePeriod="PT2S"'));
    expect(r.downloadability).toMatchObject({ status: 'downloadable', detail: 'live-recordable' });
    expect(r.playlist?.live).toBe(true);
  });
  it('malformed manifests are reported, not guessed at', async () => {
    expect((await run('<MPD><Period></Period></MPD>')).downloadability).toMatchObject({
      status: 'unsupported',
      reason: 'malformed',
    });
    expect((await run('<MPD><Period><broken></MPD>')).downloadability).toMatchObject({
      status: 'unsupported',
      reason: 'malformed',
    });
  });
  it('audio-only manifests are audio', async () => {
    const text = mpd().replace(/<AdaptationSet contentType="video"[\s\S]*?<\/AdaptationSet>/, '');
    const r = await run(text);
    expect(r.mediaType).toBe('audio');
    expect(r.variants).toHaveLength(0);
    expect(r.downloadability.status).toBe('downloadable');
  });
  it('video that already carries audio does not offer a separate track', async () => {
    const r = await run(mpd().replace('codecs="avc1.64001f"', 'codecs="avc1.64001f,mp4a.40.2"'));
    expect(r.variants.find((v) => v.height === 720)?.audioGroup).toBeUndefined();
    expect(r.variants.find((v) => v.height === 360)?.audioGroup).toBe('dash-audio');
  });
});
