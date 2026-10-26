import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { audioOptions, buildRequest, defaultChoices, planFromRequest, sanitizeRequest } from '@/lib/request';
import type { HlsRendition } from '@/types/hls';
import type { VariantInspection } from '@/types/messages';
import { makeResource } from './helpers';

const rend = (name: string, uri: string, isDefault = false): HlsRendition => ({
  type: 'AUDIO',
  groupId: 'aud',
  name,
  uri,
  isDefault,
  autoSelect: true,
});

const master = makeResource('https://a.com/master.m3u8', {
  title: 'My Show',
  kind: 'hls-master',
  format: 'hls',
  durationSec: 600,
  variants: [
    {
      uri: 'https://a.com/1080.m3u8',
      bandwidth: 3_000_000,
      width: 1920,
      height: 1080,
      codecs: 'avc1.640028,mp4a.40.2',
    },
    {
      uri: 'https://a.com/720.m3u8',
      bandwidth: 1_500_000,
      width: 1280,
      height: 720,
      codecs: 'avc1.64001f',
      audioGroup: 'aud',
    },
  ],
  audioTracks: [rend('English', 'https://a.com/en.m3u8', true), rend('Italiano', 'https://a.com/it.m3u8')],
  playlist: { playlistClass: 'hls-master', encryption: [], fragmented: false, live: false },
  downloadability: { status: 'downloadable', reason: 'ok' },
});

describe('defaultChoices / audioOptions', () => {
  it('preselects the best variant for "highest" and honours a preset cap', () => {
    expect(defaultChoices(master, DEFAULT_SETTINGS).variantIndex).toBe(0);
    expect(defaultChoices(master, { ...DEFAULT_SETTINGS, preferredQuality: '720' }).variantIndex).toBe(1);
  });
  it('offers audio renditions only for variants that reference their group', () => {
    expect(audioOptions(master, master.variants[0])).toEqual([]);
    expect(audioOptions(master, master.variants[1]).map((a) => a.name)).toEqual(['English', 'Italiano']);
  });
  it('switches video modes to original for audio-only resources', () => {
    const song = makeResource('https://a.com/s.mp3', { format: 'mp3', mediaType: 'audio' });
    expect(defaultChoices(song, DEFAULT_SETTINGS).mode).toBe('original');
  });
});

describe('buildRequest', () => {
  it('direct mp4: native, original, template-based file name', () => {
    const r = makeResource('https://a.com/v.mp4', { title: 'Clip', height: 720, sizeBytes: 1234 });
    const req = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
    expect(req).toMatchObject({
      filename: 'Clip [720p].mp4',
      isHls: false,
      sourceUrl: r.url,
      estimatedBytes: 1234,
      hasVideo: true,
    });
    expect(planFromRequest(req, { maxMemoryMb: 2048, maxEncodeDurationSec: 0 })).toMatchObject({
      valid: true,
      pipeline: 'native',
    });
  });
  it('HLS variant with muxed audio: concat to ts, estimates size from bandwidth', () => {
    const c = { ...defaultChoices(master, DEFAULT_SETTINGS), container: 'ts' as const };
    const req = buildRequest(master, DEFAULT_SETTINGS, c);
    expect(req).toMatchObject({
      sourceUrl: 'https://a.com/1080.m3u8',
      hasMuxedAudio: true,
      filename: 'My Show [1080p].ts',
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(req.audioUrl).toBeUndefined();
    expect(req.estimatedBytes).toBe(Math.round((3_000_000 * 600) / 8));
    expect(planFromRequest(req, { maxMemoryMb: 2048, maxEncodeDurationSec: 0 }).pipeline).toBe('hls-concat');
  });
  it('HLS variant with a separate audio rendition requires an FFmpeg merge', () => {
    const c = {
      ...defaultChoices(master, { ...DEFAULT_SETTINGS, preferredQuality: '720' }),
      container: 'mp4' as const,
    };
    const req = buildRequest(master, DEFAULT_SETTINGS, c);
    expect(req).toMatchObject({
      sourceUrl: 'https://a.com/720.m3u8',
      audioUrl: 'https://a.com/en.m3u8',
      hasMuxedAudio: false,
    });
    expect(planFromRequest(req, { maxMemoryMb: 2048, maxEncodeDurationSec: 0 })).toMatchObject({
      valid: true,
      requiresFfmpeg: true,
      video: 'copy',
      audio: 'copy',
    });
  });
  it('uses the inspection (fragmented, live) and its duration', () => {
    const ins: VariantInspection = {
      url: 'x',
      segmentCount: 10,
      durationSec: 100,
      live: false,
      fragmented: true,
      encryption: [],
      protectedByDrm: false,
      keyUris: [],
      origins: [],
      originSamples: {},
      firstSegmentExt: 'm4s',
    };
    const req = buildRequest(master, DEFAULT_SETTINGS, defaultChoices(master, DEFAULT_SETTINGS), ins);
    expect(req).toMatchObject({ fragmented: true, durationSec: 100, live: false });
    expect(req.filename.endsWith('.mp4')).toBe(true);
  });
  it('audio-only names the file by audio format without a resolution', () => {
    const c = {
      ...defaultChoices(master, DEFAULT_SETTINGS),
      mode: 'audio-only' as const,
      audioFormat: 'm4a' as const,
    };
    const req = buildRequest(master, DEFAULT_SETTINGS, c);
    expect(req.filename).toBe('My Show.m4a');
    expect(req.qualityLabel).toBe('M4A');
  });
  it('a custom file name is sanitised and wins over the template', () => {
    const r = makeResource('https://a.com/v.mp4');
    const req = buildRequest(r, DEFAULT_SETTINGS, {
      ...defaultChoices(r, DEFAULT_SETTINGS),
      filename: '../evil:name',
    });
    expect(req.filename).toBe('evil_name.mp4');
  });
  it('flags a live inspection as invalid', () => {
    const ins: VariantInspection = {
      url: 'x',
      segmentCount: 3,
      durationSec: 12,
      live: true,
      fragmented: false,
      encryption: [],
      protectedByDrm: false,
      keyUris: [],
      origins: [],
      originSamples: {},
      firstSegmentExt: 'ts',
    };
    const req = buildRequest(master, DEFAULT_SETTINGS, defaultChoices(master, DEFAULT_SETTINGS), ins);
    expect(planFromRequest(req, { maxMemoryMb: 2048, maxEncodeDurationSec: 0 }).issues).toContain(
      'live-stream',
    );
  });
});

describe('sanitizeRequest', () => {
  const r = makeResource('https://a.com/v.mp4');
  const base = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
  it('re-sanitises name and folder from untrusted senders', () => {
    const out = sanitizeRequest({ ...base, filename: '../../x/..\\evil<>.mp4', subfolder: '../../etc' });
    expect(out?.filename).toBe('x_.._evil_.mp4');
    expect(out?.filename).not.toMatch(/[\\/]/);
    expect(out?.subfolder).toBe('etc');
  });
  it('keeps only well-formed origins in credentialedOrigins', () => {
    const out = sanitizeRequest({
      ...base,
      credentialedOrigins: ['https://a.com', 'javascript:x', 'https://b.com/path', 'http://c.com:8080'],
    });
    expect(out?.credentialedOrigins).toEqual(['https://a.com', 'http://c.com:8080']);
  });
  it('rejects unsafe URLs', () => {
    expect(sanitizeRequest({ ...base, sourceUrl: 'javascript:alert(1)' })).toBeUndefined();
    expect(sanitizeRequest({ ...base, audioUrl: 'file:///etc/passwd' })).toBeUndefined();
  });
});

describe('buildRequest: audio-only and video-only on HLS masters', () => {
  const settings = DEFAULT_SETTINGS;
  const limits = { maxMemoryMb: 2048, maxEncodeDurationSec: 0 };
  it('audio-only fetches just the chosen audio rendition', () => {
    const c = {
      ...defaultChoices(master, { ...settings, preferredQuality: '720' }),
      mode: 'audio-only' as const,
      audioFormat: 'mp3' as const,
    };
    const req = buildRequest(master, settings, c);
    expect(req.sourceUrl).toBe('https://a.com/en.m3u8');
    expect(req.audioUrl).toBeUndefined();
    expect(planFromRequest(req, limits)).toMatchObject({ valid: true, audio: 'transcode', extension: 'mp3' });
  });
  it('audio-only without a rendition uses the lightest variant that has audio', () => {
    const c = {
      ...defaultChoices(master, settings),
      mode: 'audio-only' as const,
      audioFormat: 'm4a' as const,
    };
    const req = buildRequest(master, settings, c);
    expect(req.sourceUrl).toBe('https://a.com/1080.m3u8');
    expect(req.audioCodec).toBe('aac');
    expect(planFromRequest(req, limits)).toMatchObject({ valid: true, audio: 'copy', extension: 'm4a' });
  });
  it('video-only drops the separate audio rendition', () => {
    const c = {
      ...defaultChoices(master, { ...settings, preferredQuality: '720' }),
      mode: 'video-only' as const,
      container: 'mp4' as const,
    };
    const req = buildRequest(master, settings, c);
    expect(req.audioUrl).toBeUndefined();
    expect(planFromRequest(req, limits)).toMatchObject({ valid: true, audio: 'none', video: 'copy' });
  });
});
