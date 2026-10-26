import { describe, expect, it } from 'vitest';
import { sniffMime } from '@/lib/sniff';

const bytes = (...v: Array<number | string>): Uint8Array =>
  Uint8Array.from(v.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));
const pad = (b: Uint8Array, n = 400) => {
  const out = new Uint8Array(Math.max(n, b.length));
  out.set(b);
  return out;
};

describe('sniffMime', () => {
  it.each([
    ['MP4', bytes(0, 0, 0, 24, 'ftypisom', 0, 0, 2, 0), 'video/mp4'],
    ['QuickTime', bytes(0, 0, 0, 20, 'ftypqt  '), 'video/quicktime'],
    ['M4A', bytes(0, 0, 0, 20, 'ftypM4A '), 'audio/mp4'],
    ['3GP', bytes(0, 0, 0, 20, 'ftyp3gp5'), 'video/3gpp'],
    ['AVIF', bytes(0, 0, 0, 20, 'ftypavif'), 'image/avif'],
    ['WebM', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 'webm'), 'video/webm'],
    ['Matroska', bytes(0x1a, 0x45, 0xdf, 0xa3, 'matroska'), 'video/x-matroska'],
    ['Ogg', bytes('OggS', 0, 2), 'audio/ogg'],
    ['FLAC', bytes('fLaC', 0, 0, 0), 'audio/flac'],
    ['FLV', bytes('FLV', 1, 5, 0, 0, 0, 9), 'video/x-flv'],
    ['WAV', bytes('RIFF', 1, 2, 3, 4, 'WAVEfmt '), 'audio/wav'],
    ['AVI', bytes('RIFF', 1, 2, 3, 4, 'AVI LIST'), 'video/x-msvideo'],
    ['WebP', bytes('RIFF', 1, 2, 3, 4, 'WEBPVP8 '), 'image/webp'],
    ['AIFF', bytes('FORM', 0, 0, 0, 1, 'AIFFCOMM'), 'audio/aiff'],
    ['MP3 with ID3', bytes('ID3', 4, 0, 0), 'audio/mpeg'],
    ['MP3 frame', bytes(0xff, 0xfb, 0x90, 0x64), 'audio/mpeg'],
    ['ASF', bytes(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6), 'video/x-ms-asf'],
    ['PNG', bytes(0x89, 'PNG', 0x0d, 0x0a), 'image/png'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['GIF', bytes('GIF89a'), 'image/gif'],
    ['PDF', bytes('%PDF-1.7'), 'application/pdf'],
    ['ZIP', bytes('PK', 3, 4, 20), 'application/zip'],
    ['gzip', bytes(0x1f, 0x8b, 8, 0), 'application/gzip'],
    ['WebVTT', bytes('WEBVTT\n\n'), 'text/vtt'],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
  ] as const)('recognises %s', (_n, b, mime) => {
    expect(sniffMime(pad(b))).toBe(mime);
  });

  it('recognises MPEG-TS by its repeating sync byte', () => {
    const ts = new Uint8Array(400);
    for (const i of [0, 188, 376]) ts[i] = 0x47;
    expect(sniffMime(ts)).toBe('video/mp2t');
    ts[188] = 0;
    expect(sniffMime(ts)).toBeUndefined();
  });

  it('says nothing about unknown or tiny input', () => {
    expect(sniffMime(new Uint8Array(0))).toBeUndefined();
    expect(sniffMime(bytes(1, 2))).toBeUndefined();
    expect(sniffMime(pad(bytes('just some text that is not a known format')))).toBeUndefined();
    expect(sniffMime(new Uint8Array(512))).toBeUndefined();
    expect(sniffMime(bytes(0xff, 0xe1, 0, 0))).toBeUndefined(); // no layer bits set: not an MPEG audio frame
  });
});
