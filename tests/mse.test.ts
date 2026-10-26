import { describe, expect, it } from 'vitest';
import { mediaStartInInit, parseFragment, parseInit } from '@/lib/mse';

// ---- tiny writers for the formats under test
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const be = (n: number, len: number): Uint8Array => {
  const out = new Uint8Array(len);
  for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
};
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const box = (type: string, ...body: Uint8Array[]): Uint8Array => {
  const b = cat(...body);
  return cat(be(8 + b.length, 4), ascii(type), b);
};
const zeros = (n: number) => new Uint8Array(n);

function mp4Track(
  id: number,
  handler: 'vide' | 'soun',
  timescale: number,
  entry: string,
  w = 0,
  h = 0,
  version = 0,
) {
  const tkhd = box(
    'tkhd',
    version
      ? cat(be(1 << 24, 4), zeros(16), be(id, 4), zeros(60))
      : cat(be(0, 4), zeros(8), be(id, 4), zeros(68)),
  );
  const mdhd = box(
    'mdhd',
    version
      ? cat(be(1 << 24, 4), zeros(16), be(timescale, 4), zeros(12))
      : cat(be(0, 4), zeros(8), be(timescale, 4), zeros(8)),
  );
  const hdlr = box('hdlr', cat(be(0, 4), be(0, 4), ascii(handler), zeros(12)));
  // visual sample entry: 8 header + 6 reserved + 2 index + 16 (pre_defined etc.) + width + height
  const sampleEntry = box(entry, cat(zeros(6), be(1, 2), zeros(16), be(w, 2), be(h, 2), zeros(50)));
  const stsd = box('stsd', cat(be(0, 4), be(1, 4), sampleEntry));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))));
}
const mp4Init = (...tracks: Uint8Array[]) =>
  cat(box('ftyp', ascii('isom'), zeros(8)), box('moov', ...tracks));
const mp4Fragment = (trackId: number, ticks: number, version = 0) =>
  cat(
    box('styp', ascii('msdh')),
    box(
      'moof',
      box('mfhd', zeros(8)),
      box(
        'traf',
        box('tfhd', cat(be(0, 4), be(trackId, 4))),
        box('tfdt', version ? cat(be(1 << 24, 4), be(ticks, 8)) : cat(be(0, 4), be(ticks, 4))),
      ),
    ),
    box('mdat', zeros(32)),
  );

const vint = (n: number, len: number): Uint8Array => {
  const out = be(n, len);
  out[0] = (out[0] ?? 0) | (0x80 >> (len - 1));
  return out;
};
const el = (id: number[], ...body: Uint8Array[]): Uint8Array => {
  const b = cat(...body);
  return cat(Uint8Array.from(id), vint(b.length, 2), b);
};
const uintEl = (id: number[], n: number, len = 2) => el(id, be(n, len));
const webmInit = (opts: { scale?: number; unknownSegment?: boolean } = {}) => {
  const tracks = el(
    [0x16, 0x54, 0xae, 0x6b],
    el(
      [0xae],
      uintEl([0xd7], 1),
      uintEl([0x83], 1, 1),
      el([0x86], ascii('V_VP9')),
      el([0xe0], uintEl([0xb0], 640), uintEl([0xba], 360)),
    ),
    el([0xae], uintEl([0xd7], 2), uintEl([0x83], 2, 1), el([0x86], ascii('A_OPUS'))),
  );
  const info = el(
    [0x15, 0x49, 0xa9, 0x66],
    ...(opts.scale ? [uintEl([0x2a, 0xd7, 0xb1], opts.scale, 4)] : []),
  );
  const body = cat(info, tracks);
  const segment = opts.unknownSegment
    ? cat(
        Uint8Array.from([0x18, 0x53, 0x80, 0x67]),
        Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        body,
      )
    : cat(Uint8Array.from([0x18, 0x53, 0x80, 0x67]), vint(body.length, 4), body);
  return cat(el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii('webm'))), segment);
};
const webmCluster = (timecode: number) =>
  el([0x1f, 0x43, 0xb6, 0x75], uintEl([0xe7], timecode, 4), el([0xa3], zeros(16)));

describe('fragmented MP4', () => {
  it('reads the tracks of an initialisation segment', () => {
    const info = parseInit(
      mp4Init(mp4Track(1, 'vide', 90000, 'vp09', 1280, 720), mp4Track(2, 'soun', 48000, 'Opus')),
    );
    expect(info).toEqual({
      container: 'mp4',
      tracks: [
        { id: 1, kind: 'video', codec: 'vp09', timescale: 90000, width: 1280, height: 720 },
        { id: 2, kind: 'audio', codec: 'Opus', timescale: 48000 },
      ],
    });
  });
  it('reads version-1 headers too', () => {
    const info = parseInit(mp4Init(mp4Track(7, 'vide', 600, 'avc1', 320, 180, 1)));
    expect(info?.tracks[0]).toMatchObject({ id: 7, timescale: 600, width: 320, height: 180 });
  });
  it('reads where a media segment starts, in the track timescale (32 and 64 bit)', () => {
    expect(parseFragment(mp4Fragment(1, 270000))).toEqual({
      container: 'mp4',
      starts: [{ trackId: 1, ticks: 270000 }],
    });
    expect(parseFragment(mp4Fragment(2, 2 ** 33, 1))?.starts[0]).toEqual({ trackId: 2, ticks: 2 ** 33 });
  });
  it('tells the two apart', () => {
    expect(parseInit(mp4Fragment(1, 0))).toBeUndefined();
    expect(parseFragment(mp4Init(mp4Track(1, 'vide', 1000, 'avc1', 2, 2)))).toBeUndefined();
  });
  it('never throws on truncated or hostile input', () => {
    const init = mp4Init(mp4Track(1, 'vide', 90000, 'vp09', 64, 64));
    for (let n = 0; n < init.length; n += 7) {
      expect(() => parseInit(init.subarray(0, n))).not.toThrow();
      expect(() => parseFragment(init.subarray(0, n))).not.toThrow();
    }
    const lie = cat(be(0xffffffff, 4), ascii('moov'), zeros(40));
    expect(() => parseInit(lie)).not.toThrow();
    expect(parseInit(new Uint8Array(0))).toBeUndefined();
    expect(parseInit(ascii('definitely not media'))).toBeUndefined();
  });
});

describe('WebM', () => {
  it('reads tracks, sizes and the timecode scale', () => {
    const info = parseInit(webmInit({ scale: 1_000_000 }));
    expect(info).toEqual({
      container: 'webm',
      tracks: [
        { id: 1, kind: 'video', codec: 'V_VP9', timescale: 1000, width: 640, height: 360 },
        { id: 2, kind: 'audio', codec: 'A_OPUS', timescale: 1000 },
      ],
    });
  });
  it('defaults the scale to 1 ms and copes with an unknown-size segment (live style)', () => {
    expect(parseInit(webmInit())?.tracks[0]?.timescale).toBe(1000);
    expect(parseInit(webmInit({ unknownSegment: true }))?.tracks).toHaveLength(2);
    expect(parseInit(webmInit({ scale: 100_000 }))?.tracks[0]?.timescale).toBe(10000);
  });
  it('reads the cluster timecode', () => {
    expect(parseFragment(webmCluster(12345))).toEqual({
      container: 'webm',
      starts: [{ trackId: 0, ticks: 12345 }],
    });
  });
  it('tells init from media, and never throws', () => {
    expect(parseInit(webmCluster(1))).toBeUndefined();
    expect(parseFragment(webmInit())).toBeUndefined();
    const init = webmInit();
    for (let n = 0; n < init.length; n += 5) expect(() => parseInit(init.subarray(0, n))).not.toThrow();
    expect(parseInit(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0xff]))).toBeUndefined();
    expect(
      parseFragment(
        Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      ),
    ).toBeUndefined();
  });
});

describe('init and media appended together', () => {
  it('finds where the media starts inside an MP4 chunk, including a styp before the moof', () => {
    const init = mp4Init(mp4Track(1, 'vide', 1000, 'avc1', 64, 64));
    const frag = mp4Fragment(1, 0); // styp + moof + mdat
    expect(mediaStartInInit(cat(init, frag))).toBe(init.length);
    expect(mediaStartInInit(init)).toBeUndefined();
    expect(mediaStartInInit(frag)).toBeUndefined();
    const sidx = box('sidx', zeros(12));
    expect(mediaStartInInit(cat(init, sidx, box('moof', box('mfhd', zeros(8)))))).toBe(init.length);
  });
  it('finds the first Cluster after a WebM header', () => {
    const init = webmInit();
    const both = cat(init, webmCluster(0), webmCluster(2000));
    expect(mediaStartInInit(both)).toBe(init.length);
    expect(mediaStartInInit(init)).toBeUndefined();
    expect(mediaStartInInit(webmCluster(5))).toBeUndefined();
  });
  it('never throws on garbage', () => {
    for (const n of [0, 1, 3, 9, 40])
      expect(() => mediaStartInInit(new Uint8Array(n).fill(0xff))).not.toThrow();
  });
});
