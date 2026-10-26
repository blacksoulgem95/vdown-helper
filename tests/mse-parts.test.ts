import { describe, expect, it } from 'vitest';
import { ChunkClassifier, chunkSignature, planParts, type ChunkMeta } from '@/lib/mseParts';
import type { InitInfo } from '@/lib/mse';

const init = (
  track: string,
  seq: number,
  sig: string,
  kinds: Array<'video' | 'audio'>,
  w = 640,
): ChunkMeta => {
  const info: InitInfo = {
    container: 'mp4',
    tracks: kinds.map((k, i) => ({
      id: i + 1,
      kind: k,
      codec: k === 'video' ? 'avc1' : 'mp4a',
      timescale: 1000,
      ...(k === 'video' ? { width: w, height: w / 2 } : {}),
    })),
  };
  return { track, seq, kind: 'init', offset: 0, length: 100, sig, init: info, container: 'mp4' };
};
const media = (track: string, seq: number, startSec: number | undefined, sig = `m${seq}`): ChunkMeta => ({
  track,
  seq,
  kind: 'media',
  offset: seq * 1000,
  length: 1000,
  sig,
  ...(startSec !== undefined ? { startSec } : {}),
  container: 'mp4',
});

describe('chunkSignature', () => {
  it('is equal for equal bytes and differs when length, head or tail differ', () => {
    const a = Uint8Array.from({ length: 10_000 }, (_, i) => i % 251);
    expect(chunkSignature(a)).toBe(chunkSignature(a.slice()));
    const b = a.slice();
    b[0] = 9;
    const c = a.slice();
    c[9999] = 9;
    expect(
      new Set([chunkSignature(a), chunkSignature(b), chunkSignature(c), chunkSignature(a.subarray(0, 9999))])
        .size,
    ).toBe(4);
  });
});

describe('planParts', () => {
  it('one quality, audio and video: one part with both tracks, in time order and without repeats', () => {
    const plan = planParts([
      init('v', 0, 'VI', ['video']),
      init('a', 1, 'AI', ['audio']),
      media('v', 2, 0),
      media('a', 3, 0),
      media('v', 4, 4),
      media('a', 5, 4),
      media('v', 6, 2), // arrived out of order
      media('v', 7, 4, 'again'), // the same segment appended again after a seek
    ]);
    expect(plan.parts).toHaveLength(1);
    const p = plan.parts[0]!;
    expect(p.tracks.map((t) => [t.track, t.role, t.chunks.map((c) => c.seq)])).toEqual([
      ['v', 'video', [0, 2, 6, 4]],
      ['a', 'audio', [1, 3, 5]],
    ]);
    expect(p.video).toMatchObject({ codec: 'avc1', width: 640 });
    expect(p.audio).toMatchObject({ codec: 'mp4a' });
    expect(plan.duplicates).toBe(1);
    expect(plan.orphans).toBe(0);
  });

  it('a quality switch starts a new part; audio follows the time windows, never re-encoded or duplicated', () => {
    const plan = planParts([
      init('v', 0, 'LOW', ['video'], 320),
      init('a', 1, 'AI', ['audio']),
      media('v', 2, 0),
      media('a', 3, 0),
      media('v', 4, 2),
      media('a', 5, 2),
      init('v', 6, 'HIGH', ['video'], 1280), // switch at 4 s
      media('a', 7, 4),
      media('v', 8, 4),
      media('a', 9, 6),
      media('v', 10, 6),
    ]);
    expect(plan.parts).toHaveLength(2);
    const [p1, p2] = plan.parts as [(typeof plan.parts)[0], (typeof plan.parts)[0]];
    expect([p1.startSec, p1.endSec, p1.video?.width]).toEqual([0, 4, 320]);
    expect([p2.startSec, p2.endSec, p2.video?.width]).toEqual([4, Infinity, 1280]);
    expect(p1.tracks[1]!.chunks.map((c) => c.seq)).toEqual([1, 3, 5]);
    expect(p2.tracks[1]!.chunks.map((c) => c.seq)).toEqual([1, 7, 9]);
    // every media segment is in exactly one part
    const all = plan.parts.flatMap((p) =>
      p.tracks.flatMap((t) => t.chunks.filter((c) => c.kind === 'media').map((c) => c.seq)),
    );
    expect(all.sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 7, 8, 9, 10]);
  });

  it('an init appended again unchanged does not split; an init with nothing recorded under it is replaced', () => {
    const same = planParts([
      init('v', 0, 'X', ['video']),
      media('v', 1, 0),
      init('v', 2, 'X', ['video']),
      media('v', 3, 2),
    ]);
    expect(same.parts).toHaveLength(1);
    const replaced = planParts([
      init('v', 0, 'X', ['video']),
      init('v', 1, 'Y', ['video']),
      media('v', 2, 0),
    ]);
    expect(replaced.parts).toHaveLength(1);
    expect(replaced.parts[0]!.tracks[0]!.chunks[0]!.sig).toBe('Y');
  });

  it('a muxed SourceBuffer (audio and video together) is a single file', () => {
    const plan = planParts([init('m', 0, 'M', ['video', 'audio']), media('m', 1, 0), media('m', 2, 2)]);
    expect(plan.parts[0]!.tracks).toHaveLength(1);
    expect(plan.parts[0]!.tracks[0]!.role).toBe('muxed');
    expect(plan.parts[0]!.audio).toBeDefined();
  });

  it('an audio-only capture is one part', () => {
    const plan = planParts([init('a', 0, 'A', ['audio']), media('a', 1, 0), media('a', 2, 2)]);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]!.video).toBeUndefined();
    expect(plan.parts[0]!.tracks[0]!.chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it('counts what it cannot use: media before any init, and a track that never got one', () => {
    const plan = planParts([
      media('v', 0, 0),
      init('v', 1, 'V', ['video']),
      media('v', 2, 0),
      media('ghost', 3, 0),
    ]);
    expect(plan.parts).toHaveLength(1);
    expect(plan.orphans).toBe(2);
  });

  it('yields nothing for an empty or media-less capture', () => {
    expect(planParts([]).parts).toEqual([]);
    expect(planParts([init('v', 0, 'V', ['video'])]).parts).toEqual([]);
  });

  it('segments without a start time keep their arrival order', () => {
    const plan = planParts([
      init('v', 0, 'V', ['video']),
      media('v', 1, undefined),
      media('v', 2, undefined),
    ]);
    expect(plan.parts[0]!.tracks[0]!.chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });
});

describe('ChunkClassifier', () => {
  it('classifies an MP4 init and a fragment, converting the start to seconds with the init timescale', () => {
    // minimal moov with one video track (timescale 1000) and a moof with tfdt 5000
    const be = (n: number, len: number) =>
      Uint8Array.from({ length: len }, (_, i) => Math.floor(n / 256 ** (len - 1 - i)) % 256);
    const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
    const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
    const box = (t: string, ...b: Uint8Array[]) => {
      const body = cat(...b);
      return cat(be(8 + body.length, 4), ascii(t), body);
    };
    const z = (n: number) => new Uint8Array(n);
    const trak = box(
      'trak',
      box('tkhd', cat(be(0, 4), z(8), be(1, 4), z(68))),
      box(
        'mdia',
        box('mdhd', cat(be(0, 4), z(8), be(1000, 4), z(8))),
        box('hdlr', cat(be(0, 4), be(0, 4), ascii('vide'), z(12))),
        box(
          'minf',
          box(
            'stbl',
            box(
              'stsd',
              cat(be(0, 4), be(1, 4), box('avc1', z(6), be(1, 2), z(16), be(640, 2), be(360, 2), z(50))),
            ),
          ),
        ),
      ),
    );
    const initBytes = cat(box('ftyp', ascii('isom'), z(8)), box('moov', trak));
    const frag = cat(
      box(
        'moof',
        box('mfhd', z(8)),
        box('traf', box('tfhd', cat(be(0, 4), be(1, 4))), box('tfdt', cat(be(0, 4), be(5000, 4)))),
      ),
      box('mdat', z(8)),
    );
    const c = new ChunkClassifier();
    const i = c.classify('v', 0, initBytes, 0);
    expect(i.kind).toBe('init');
    expect(i.init?.tracks[0]).toMatchObject({ kind: 'video', width: 640 });
    const m = c.classify('v', 1, frag, initBytes.length);
    expect(m).toMatchObject({
      kind: 'media',
      startSec: 5,
      container: 'mp4',
      offset: initBytes.length,
      length: frag.length,
    });
    // a media chunk of a track whose init was never seen still gets recorded, without a time
    expect(new ChunkClassifier().classify('x', 0, frag, 0)).toMatchObject({ kind: 'media' });
    expect(new ChunkClassifier().classify('x', 0, frag, 0).startSec).toBeUndefined();
  });
});
