import { describe, expect, it } from 'vitest';
import { classifyPlaylist, parseHls } from '@/lib/hls/parser';
import { parseAttributes } from '@/lib/hls/attributes';
import type { HlsMasterPlaylist, HlsMediaPlaylist } from '@/types/hls';
import { AES, DASH, FMP4, LIVE, MASTER, MEDIA, PLAIN_M3U, SAMPLE_AES, WIDEVINE } from './fixtures/hls';

const BASE = 'https://media.example.com/video/master.m3u8';

function master(text: string): HlsMasterPlaylist {
  const r = parseHls(text, BASE);
  if (!r.ok || r.playlist.kind !== 'hls-master') throw new Error('expected master');
  return r.playlist;
}
function media(text: string, base = 'https://media.example.com/video/index.m3u8'): HlsMediaPlaylist {
  const r = parseHls(text, base);
  if (!r.ok || r.playlist.kind !== 'hls-media')
    throw new Error(`expected media: ${r.ok ? '' : r.error.message}`);
  return r.playlist;
}

describe('parseAttributes', () => {
  it('handles quoted values containing commas', () => {
    expect(parseAttributes('BANDWIDTH=1000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720')).toEqual({
      BANDWIDTH: '1000',
      CODECS: 'avc1.64001f,mp4a.40.2',
      RESOLUTION: '1280x720',
    });
  });
  it('tolerates a missing closing quote', () => {
    expect(parseAttributes('A="x,B=2')['A']).toBe('x,B=2');
  });
});

describe('classifyPlaylist', () => {
  it('separates HLS master, HLS media, plain M3U, DASH and unsupported', () => {
    expect(classifyPlaylist(MASTER)).toBe('hls-master');
    expect(classifyPlaylist(MEDIA)).toBe('hls-media');
    expect(classifyPlaylist(PLAIN_M3U)).toBe('m3u-plain');
    expect(classifyPlaylist(DASH)).toBe('dash');
    expect(classifyPlaylist('<html></html>')).toBe('unsupported');
    expect(classifyPlaylist('')).toBe('unsupported');
  });
  it('handles a UTF-8 BOM and CRLF line endings', () => {
    expect(classifyPlaylist('\uFEFF' + MEDIA.replace(/\n/g, '\r\n'))).toBe('hls-media');
  });
});

describe('master playlist', () => {
  it('lists only variants present, highest resolution first', () => {
    const m = master(MASTER);
    expect(m.variants.map((v) => v.height)).toEqual([1080, 720, 360]);
    expect(m.variants).toHaveLength(3);
  });
  it('reads bandwidth, resolution, frame rate and codecs when present', () => {
    const v720 = master(MASTER).variants.find((v) => v.height === 720);
    expect(v720).toMatchObject({
      bandwidth: 1_400_000,
      averageBandwidth: 1_200_000,
      width: 1280,
      frameRate: 29.97,
      codecs: 'avc1.64001f,mp4a.40.2',
      audioGroup: 'aud',
    });
  });
  it('leaves absent attributes undefined (no invented values)', () => {
    const v360 = master(MASTER).variants.find((v) => v.height === 360);
    expect(v360?.frameRate).toBeUndefined();
    expect(v360?.audioGroup).toBeUndefined();
  });
  it('resolves relative, parent-relative and absolute URIs', () => {
    const uris = master(MASTER).variants.map((v) => v.uri);
    expect(uris).toContain('https://media.example.com/video/720p/index.m3u8');
    expect(uris).toContain('https://cdn.example.com/1080p/index.m3u8?token=abc');
    expect(uris).toContain('https://media.example.com/360p/index.m3u8');
  });
  it('exposes separate audio renditions and ignores I-frame streams as variants', () => {
    const m = master(MASTER);
    const audio = m.renditions.filter((r) => r.type === 'AUDIO');
    expect(audio.map((a) => [a.name, a.language, a.isDefault])).toEqual([
      ['English', 'en', true],
      ['Italiano', 'it', false],
    ]);
    expect(audio[0]?.uri).toBe('https://media.example.com/video/audio/en/index.m3u8');
    expect(m.iFrameStreams).toBe(1);
  });
  it('reports a variant without BANDWIDTH as malformed', () => {
    const r = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=640x360\na.m3u8\n', BASE);
    expect(r).toMatchObject({ ok: false, error: { code: 'malformed', line: 2 } });
  });
  it('rejects master playlists with no variants', () => {
    const r = parseHls(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"\n',
      BASE,
    );
    expect(r.ok).toBe(false);
  });
  it('rejects variant URIs with dangerous schemes', () => {
    const r = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\njavascript:alert(1)\n', BASE);
    expect(r).toMatchObject({ ok: false, error: { code: 'unsafe-url' } });
  });
});

describe('media playlist', () => {
  it('parses segments, durations, sequence numbers and endlist', () => {
    const p = media(MEDIA);
    expect(p.segments.map((s) => s.sequence)).toEqual([7, 8, 9]);
    expect(p.segments[0]).toMatchObject({ duration: 9.009, title: 'first' });
    expect(p.totalDuration).toBeCloseTo(21.021, 3);
    expect(p.targetDuration).toBe(10);
    expect(p.mediaSequence).toBe(7);
    expect(p.endList).toBe(true);
    expect(p.playlistType).toBe('VOD');
    expect(p.segments[2]?.discontinuity).toBe(true);
  });
  it('resolves relative and root-relative segment URLs', () => {
    const p = media(MEDIA);
    expect(p.segments[0]?.uri).toBe('https://media.example.com/video/seg7.ts');
    expect(p.segments[2]?.uri).toBe('https://media.example.com/abs/seg9.ts');
  });
  it('flags playlists without ENDLIST as live', () => {
    expect(media(LIVE).endList).toBe(false);
  });
  it('parses EXT-X-MAP and byte ranges, continuing ranges of the same resource', () => {
    const p = media(FMP4);
    expect(p.fragmented).toBe(true);
    expect(p.segments[0]?.map).toEqual({
      uri: 'https://media.example.com/video/init.mp4',
      byteRange: { length: 720, offset: 0 },
    });
    expect(p.segments[0]?.byteRange).toEqual({ length: 1000, offset: 720 });
    expect(p.segments[1]?.byteRange).toEqual({ length: 1500, offset: 1720 });
  });
  it('detects AES-128 with an identity key as decryptable', () => {
    const p = media(AES);
    expect(p.encryption).toEqual(['AES-128']);
    expect(p.hasDrm).toBe(false);
    expect(p.segments[0]?.key).toMatchObject({
      method: 'AES-128',
      uri: 'https://media.example.com/video/key.bin',
      iv: '0x00000000000000000000000000000001',
      protectedByDrm: false,
    });
  });
  it('treats SAMPLE-AES and DRM key formats as protected', () => {
    expect(media(SAMPLE_AES).hasDrm).toBe(true);
    expect(media(WIDEVINE).hasDrm).toBe(true);
  });
  it('rejects a playlist with no segments', () => {
    const r = parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-ENDLIST\n', BASE);
    expect(r).toMatchObject({ ok: false, error: { code: 'malformed' } });
  });
  it('rejects an invalid EXTINF duration', () => {
    const r = parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:abc,\na.ts\n', BASE);
    expect(r).toMatchObject({ ok: false, error: { code: 'malformed', line: 3 } });
  });
  it('rejects segments with non-http(s) schemes', () => {
    const r = parseHls(
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n',
      BASE,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'unsafe-url' } });
  });
});

describe('invalid and unsupported input', () => {
  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    ['<html>nope</html>', 'not-m3u'],
    ['hello', 'not-m3u'],
    [PLAIN_M3U, 'not-hls'],
    [DASH, 'dash'],
  ])('returns a typed error for %j', (text, code) => {
    expect(parseHls(text, BASE)).toMatchObject({ ok: false, error: { code } });
  });
  it('never throws on garbage', () => {
    for (const junk of [
      '#EXTM3U\n#EXT-X-STREAM-INF:\n',
      '#EXTM3U\n#EXT-X-KEY:\n#EXTINF:1,\nx',
      '#EXTM3U\n\0\0\n',
    ]) {
      expect(() => parseHls(junk, BASE)).not.toThrow();
    }
  });
});

describe('hostile playlists (security review M3)', () => {
  it('does not multiply a long base address into every segment, and caps the segment count', () => {
    const lines = Array.from({ length: 2000 }, () => '#EXTINF:1,\nx').join('\n');
    const longBase = `https://evil.test/${'a'.repeat(100_000)}/p.m3u8`;
    const t0 = performance.now();
    const r = parseHls(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n${lines}\n#EXT-X-ENDLIST\n`, longBase);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(false); // every segment address would be too long: nothing usable, and nothing held
    const many = Array.from({ length: 20_500 }, (_, i) => `#EXTINF:1,\ns${i}.ts`).join('\n');
    const big = parseHls(
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n${many}\n#EXT-X-ENDLIST\n`,
      'https://a.test/p.m3u8',
    );
    expect(big.ok).toBe(false);
  });
});
