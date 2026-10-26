import { describe, expect, it } from 'vitest';
import { analyzeCandidates, type Fetcher } from '@/lib/analyze';
import { buildRequest, defaultChoices, planFromRequest } from '@/lib/request';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import type { ProbeResult } from '@/lib/netprobe';
import type { RawCandidate } from '@/types/media';
import { MASTER } from './fixtures/hls';

const ctx = { tabId: 1, pageUrl: 'https://site.example/watch', pageTitle: 'Watch page', now: 1 };
const MASTER_URL = 'https://cdn.example/vod/master.m3u8';
const SUBS_URL = 'https://cdn.example/vod/subs/en.m3u8';

const text = (
  body: string,
  finalUrl: string,
  contentType = 'application/vnd.apple.mpegurl',
): ProbeResult => ({
  ok: true,
  status: 200,
  contentType,
  acceptRanges: false,
  finalUrl,
  text: body,
});
const head = (contentType: string, contentLength?: number): ProbeResult => ({
  ok: true,
  status: 200,
  contentType,
  acceptRanges: true,
  finalUrl: '',
  ...(contentLength ? { contentLength } : {}),
});
function fetcher(map: Record<string, ProbeResult>): Fetcher {
  const get = async (url: string): Promise<ProbeResult> =>
    map[url] ?? { ok: false, kind: 'http', status: 404 };
  return { head: get, text: get };
}
const cand = (url: string, extra: Partial<RawCandidate> = {}): RawCandidate => ({
  url,
  method: 'dom-element',
  ...extra,
});

const VTT_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
seg0.vtt
#EXTINF:10,
seg1.vtt
#EXT-X-ENDLIST
`;

describe('subtitle detection', () => {
  it('a <track> becomes a subtitle with its language, as WebVTT', async () => {
    const url = 'https://cdn.example/cc/en';
    const [r] = await analyzeCandidates(
      [
        cand(url, {
          method: 'dom-track',
          role: 'subtitle',
          language: 'en',
          mimeType: 'text/vtt',
          title: 'English',
        }),
      ],
      ctx,
      fetcher({ [url]: head('text/vtt; charset=utf-8', 1234) }),
    );
    expect(r).toMatchObject({
      kind: 'subtitle',
      format: 'vtt',
      language: 'en',
      title: 'English',
      sizeBytes: 1234,
      mediaType: 'unknown',
      downloadability: { status: 'downloadable', reason: 'ok' },
    });
  });

  it('subtitle files are recognised by extension and MIME type', async () => {
    const out = await analyzeCandidates(
      [
        cand('https://cdn.example/a.srt'),
        cand('https://cdn.example/b.ttml'),
        cand('https://cdn.example/c.vtt'),
      ],
      ctx,
      fetcher({
        'https://cdn.example/a.srt': head('application/x-subrip', 10),
        'https://cdn.example/b.ttml': head('application/ttml+xml', 20),
        'https://cdn.example/c.vtt': head('text/plain', 30),
      }),
    );
    expect(out.map((r) => [r.kind, r.format])).toEqual([
      ['subtitle', 'srt'],
      ['subtitle', 'ttml'],
      ['subtitle', 'vtt'],
    ]);
  });

  it('refuses a "subtitle" that is really an HTML error page', async () => {
    const [r] = await analyzeCandidates(
      [cand('https://cdn.example/x.vtt')],
      ctx,
      fetcher({ 'https://cdn.example/x.vtt': head('text/html') }),
    );
    expect(r?.downloadability).toMatchObject({ status: 'unsupported', reason: 'unsupported-format' });
  });

  it('lists the subtitle renditions of an HLS master as subtitles, probing their playlist', async () => {
    const out = await analyzeCandidates(
      [cand(MASTER_URL)],
      ctx,
      fetcher({
        [MASTER_URL]: text(MASTER, MASTER_URL),
        'https://cdn.example/vod/720p/index.m3u8': text(VTT_PLAYLIST.replace(/seg/g, 'v'), ''),
        [SUBS_URL]: text(VTT_PLAYLIST, SUBS_URL),
      }),
    );
    const sub = out.find((r) => r.kind === 'subtitle');
    expect(sub).toMatchObject({
      url: SUBS_URL,
      format: 'hls',
      language: 'en',
      durationSec: 20,
      downloadability: { status: 'downloadable', reason: 'ok' },
    });
    expect(out.filter((r) => r.kind === 'subtitle')).toHaveLength(1);
  });

  it('does not list the segments of a subtitle playlist as subtitles of their own', async () => {
    const out = await analyzeCandidates(
      [
        cand(MASTER_URL),
        cand('https://cdn.example/vod/subs/seg0.vtt', { method: 'network' }),
        cand('https://cdn.example/vod/subs/seg1.vtt', { method: 'network' }),
      ],
      ctx,
      fetcher({
        [MASTER_URL]: text(MASTER, MASTER_URL),
        [SUBS_URL]: text(VTT_PLAYLIST, SUBS_URL),
        'https://cdn.example/vod/subs/seg0.vtt': head('text/vtt', 100),
        'https://cdn.example/vod/subs/seg1.vtt': head('text/vtt', 100),
      }),
    );
    expect(out.filter((r) => r.kind === 'subtitle').map((r) => r.url)).toEqual([SUBS_URL]);
  });

  it('a WebVTT playlist found on its own is a subtitle, not a video', async () => {
    const [r] = await analyzeCandidates(
      [cand(SUBS_URL)],
      ctx,
      fetcher({ [SUBS_URL]: text(VTT_PLAYLIST, SUBS_URL) }),
    );
    expect(r).toMatchObject({ kind: 'subtitle', format: 'hls', mediaType: 'unknown' });
  });

  it('reads text tracks from a DASH manifest, but refuses WebVTT-in-MP4 cues', async () => {
    const mpd = 'https://cdn.example/show/manifest.mpd';
    const body = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1000" duration="4000" initialization="i.mp4" media="$Number$.m4s"/>
    <Representation id="v" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e"/></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="application/mp4" codecs="stpp" lang="it"><SegmentTemplate timescale="1000" duration="4000" media="t/$Number$.m4s"/>
    <Representation id="it-ttml" bandwidth="1000"/></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="application/mp4" codecs="wvtt" lang="fr"><SegmentTemplate timescale="1000" duration="4000" media="w/$Number$.m4s"/>
    <Representation id="fr-vtt" bandwidth="1000"/></AdaptationSet>
</Period></MPD>`;
    const out = await analyzeCandidates(
      [cand(mpd)],
      ctx,
      fetcher({ [mpd]: text(body, mpd, 'application/dash+xml') }),
    );
    const subs = out.filter((r) => r.kind === 'subtitle');
    expect(subs.map((r) => [r.url, r.format, r.language, r.downloadability.status])).toEqual([
      [`${mpd}#vdh-rep=it-ttml`, 'dash', 'it', 'downloadable'],
      [`${mpd}#vdh-rep=fr-vtt`, 'dash', 'fr', 'unsupported'],
    ]);
    expect(subs[1]?.downloadability.reason).toBe('subtitle-unsupported');
  });
});

describe('subtitle requests', () => {
  const sub = async (url: string, format: string, extra: Partial<RawCandidate> = {}) => {
    const [r] = await analyzeCandidates(
      [cand(url, { role: 'subtitle', language: 'it', ...extra })],
      ctx,
      fetcher({ [url]: head(format) }),
    );
    return r!;
  };

  it('a plain document saved as found is a native download with the right extension', async () => {
    const r = await sub('https://cdn.example/cc/it.vtt', 'text/vtt');
    const req = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
    const plan = planFromRequest(req, { maxMemoryMb: 1, maxEncodeDurationSec: 1 });
    expect(plan).toMatchObject({ valid: true, pipeline: 'native', extension: 'vtt', requiresFfmpeg: false });
    expect(req.filename.endsWith('.vtt')).toBe(true);
    expect(req.filename).toContain('it');
  });

  it('conversion to SRT goes through the subtitle pipeline', async () => {
    const r = await sub('https://cdn.example/cc/it.vtt', 'text/vtt');
    const req = buildRequest(r, DEFAULT_SETTINGS, {
      ...defaultChoices(r, DEFAULT_SETTINGS),
      subtitleOutput: 'srt',
    });
    const plan = planFromRequest(req, { maxMemoryMb: 1, maxEncodeDurationSec: 1 });
    expect(plan).toMatchObject({ valid: true, pipeline: 'subtitle', extension: 'srt' });
    expect(req.filename.endsWith('.srt')).toBe(true);
  });

  it('a segmented subtitle stream is joined into WebVTT or SRT; live ones are refused', async () => {
    const [r] = await analyzeCandidates(
      [cand(SUBS_URL)],
      ctx,
      fetcher({ [SUBS_URL]: text(VTT_PLAYLIST, SUBS_URL) }),
    );
    const req = buildRequest(r!, DEFAULT_SETTINGS, defaultChoices(r!, DEFAULT_SETTINGS));
    const limits = { maxMemoryMb: 1, maxEncodeDurationSec: 1 };
    expect(planFromRequest(req, limits)).toMatchObject({
      valid: true,
      pipeline: 'subtitle',
      extension: 'vtt',
    });
    expect(planFromRequest({ ...req, live: true }, limits)).toMatchObject({
      valid: false,
      issues: ['live-stream'],
    });
  });

  it('a subtitle of unknown format can only be saved converted', async () => {
    const [r] = await analyzeCandidates(
      [cand('https://cdn.example/cc?id=1', { role: 'subtitle' })],
      ctx,
      fetcher({ 'https://cdn.example/cc?id=1': head('application/octet-stream') }),
    );
    // <track> sources are WebVTT by definition, so a track is "vtt"; a bare unknown file is not
    expect(r?.format).toBe('vtt');
    const unknown = { ...r!, format: 'unknown' as const };
    expect(defaultChoices(unknown, DEFAULT_SETTINGS).subtitleOutput).toBe('srt');
    const req = buildRequest(unknown, DEFAULT_SETTINGS, {
      ...defaultChoices(unknown, DEFAULT_SETTINGS),
      subtitleOutput: 'original',
    });
    expect(req.subtitle?.output).toBe('srt');
  });
});
