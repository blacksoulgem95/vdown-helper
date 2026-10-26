import { describe, expect, it } from 'vitest';
import { assembleCues, cuesFromBytes, decodeSubtitleBytes, mdatPayloads } from '@/lib/subtitleBytes';
import { formatSrt } from '@/lib/subtitles';

const enc = (s: string) => new TextEncoder().encode(s);

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc(type), 4);
  out.set(payload, 8);
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const TTML = (begin: string, end: string, text: string) =>
  `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="${begin}" end="${end}">${text}</p></div></body></tt>`;

describe('mdatPayloads', () => {
  it('returns the payload of each mdat box and skips the others', () => {
    const file = concat(
      box('styp', enc('abcd')),
      box('moof', enc('xx')),
      box('mdat', enc('one')),
      box('mdat', enc('two')),
    );
    expect(mdatPayloads(file).map((p) => new TextDecoder().decode(p))).toEqual(['one', 'two']);
  });
  it('handles a 64-bit size and a box that runs to the end', () => {
    const big = new Uint8Array(16 + 3);
    const v = new DataView(big.buffer);
    v.setUint32(0, 1);
    big.set(enc('mdat'), 4);
    v.setBigUint64(8, BigInt(19));
    big.set(enc('big'), 16);
    const toEnd = new Uint8Array(8 + 3);
    new DataView(toEnd.buffer).setUint32(0, 0);
    toEnd.set(enc('mdat'), 4);
    toEnd.set(enc('end'), 8);
    expect(mdatPayloads(concat(big, toEnd)).map((p) => new TextDecoder().decode(p))).toEqual(['big', 'end']);
  });
  it('never throws on garbage or truncated input', () => {
    expect(mdatPayloads(new Uint8Array(0))).toEqual([]);
    expect(mdatPayloads(enc('not an mp4 at all'))).toEqual([]);
    const lie = new Uint8Array(8);
    new DataView(lie.buffer).setUint32(0, 0xffffff);
    lie.set(enc('mdat'), 4);
    expect(mdatPayloads(lie)[0]?.length).toBe(0);
    const tiny = new Uint8Array(8);
    new DataView(tiny.buffer).setUint32(0, 4); // smaller than its own header
    expect(mdatPayloads(tiny)).toEqual([]);
  });
});

describe('cues from fetched bytes', () => {
  it('reads a text document, and TTML carried in MP4 mdat (stpp), several documents per box', () => {
    expect(cuesFromBytes(enc('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'))).toEqual([
      { start: 1, end: 2, text: 'Hi' },
    ]);
    const mp4 = concat(
      box('moof', enc('x')),
      box('mdat', enc(TTML('00:00:03.000', '00:00:04.000', 'A') + TTML('00:00:05.000', '00:00:06.000', 'B'))),
    );
    expect(cuesFromBytes(mp4).map((c) => [c.start, c.text])).toEqual([
      [3, 'A'],
      [5, 'B'],
    ]);
  });
  it('decodes legacy Windows-1252 files when they are not valid UTF-8', () => {
    const latin1 = Uint8Array.from([...enc('caff'), 0xe8]); // "caffè"
    expect(decodeSubtitleBytes(latin1)).toBe('caffè');
  });
});

describe('assembleCues', () => {
  const seg = (map: string, cue: string) =>
    enc(`WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${map},LOCAL:00:00:00.000\n\n${cue}\n`);
  it('places HLS WebVTT segments on one timeline using X-TIMESTAMP-MAP and drops repeats', () => {
    const cues = assembleCues([
      seg('900000', '00:00:01.000 --> 00:00:03.000\nfirst'), // 10 s
      seg('900000', '00:00:01.000 --> 00:00:03.000\nfirst'), // an overlapping repeat
      seg('1800000', '00:00:01.000 --> 00:00:02.000\nsecond'), // 20 s
    ]);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 3, 'first'],
      [11, 12, 'second'],
    ]);
  });
  it('converts the joined result to a valid SRT', () => {
    const srt = formatSrt(assembleCues([enc('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n')]));
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello\n');
  });
  it('joins stpp segments from several MP4 files in time order', () => {
    const a = concat(box('mdat', enc(TTML('00:00:08.000', '00:00:09.000', 'late'))));
    const b = concat(box('mdat', enc(TTML('00:00:01.000', '00:00:02.000', 'early'))));
    expect(assembleCues([a, b]).map((c) => c.text)).toEqual(['early', 'late']);
  });
});
