import {
  mediaStartInInit,
  parseFragment,
  parseInit,
  type Container,
  type InitInfo,
  type TrackInfo,
} from './mse';

/** What is known about one chunk a player appended to a SourceBuffer. The bytes themselves live on disk. */
export interface ChunkMeta {
  /** SourceBuffer the chunk went to (the hook's id). */
  track: string;
  /** Arrival order across the whole capture. */
  seq: number;
  kind: 'init' | 'media';
  /** Where the chunk sits in its track's staged file. */
  offset: number;
  length: number;
  /** Content signature: equal chunks have equal signatures. */
  sig: string;
  /** Media chunks: where the segment starts on the media timeline, in seconds. */
  startSec?: number;
  /** Init chunks: what the tracks are. */
  init?: InitInfo;
  container?: Container;
}

/** FNV-1a over the length, the head and the tail: cheap, and enough to recognise a segment appended twice. */
export function chunkSignature(b: Uint8Array): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 0x01000193);
  };
  mix(b.length & 0xff);
  mix((b.length >>> 8) & 0xff);
  mix((b.length >>> 16) & 0xff);
  mix((b.length >>> 24) & 0xff);
  const edge = 4096;
  for (let i = 0; i < Math.min(edge, b.length); i++) mix(b[i] as number);
  for (let i = Math.max(edge, b.length - edge); i < b.length; i++) mix(b[i] as number);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Classifies chunks as they arrive, remembering each SourceBuffer's latest initialisation segment. */
export class ChunkClassifier {
  private inits = new Map<string, InitInfo>();

  /**
   * Classify one append. A player that appends the initialisation segment together with the first media segment gets
   * two entries (the bytes stay contiguous on disk, so offsets and lengths simply divide the chunk).
   */
  classifyAll(track: string, seq: number, bytes: Uint8Array, offset: number): ChunkMeta[] {
    const cut = mediaStartInInit(bytes);
    if (cut === undefined) return [this.classify(track, seq, bytes, offset)];
    return [
      this.classify(track, seq, bytes.subarray(0, cut), offset),
      this.classify(track, seq, bytes.subarray(cut), offset + cut),
    ];
  }

  classify(track: string, seq: number, bytes: Uint8Array, offset: number): ChunkMeta {
    const base = { track, seq, offset, length: bytes.length, sig: chunkSignature(bytes) };
    const init = parseInit(bytes);
    if (init) {
      this.inits.set(track, init);
      return { ...base, kind: 'init', init, container: init.container };
    }
    const frag = parseFragment(bytes);
    const known = this.inits.get(track);
    let startSec: number | undefined;
    if (frag && known) {
      for (const s of frag.starts) {
        // WebM clusters carry one timecode for every track; MP4 names its track
        const t = known.tracks.find((x) => x.id === s.trackId) ?? known.tracks[0];
        if (!t || !t.timescale) continue;
        const sec = s.ticks / t.timescale;
        startSec = startSec === undefined ? sec : Math.min(startSec, sec);
      }
    }
    return {
      ...base,
      kind: 'media',
      ...(startSec !== undefined ? { startSec } : {}),
      container: frag?.container ?? known?.container ?? 'mp4',
    };
  }
}

export interface PartTrack {
  track: string;
  role: 'video' | 'audio' | 'muxed';
  /** The initialisation segment to start the file with, then the media segments in time order. */
  chunks: ChunkMeta[];
}

export interface Part {
  index: number;
  container: Container;
  /** Media time covered by the video of this part (seconds). */
  startSec: number;
  endSec: number;
  video?: TrackInfo;
  audio?: TrackInfo;
  tracks: PartTrack[];
}

export interface PartPlan {
  parts: Part[];
  /** Media chunks that arrived before any initialisation segment of their SourceBuffer and cannot be used. */
  orphans: number;
  /** Chunks left out because the same segment was appended more than once. */
  duplicates: number;
}

const initTracks = (m: ChunkMeta): TrackInfo[] => m.init?.tracks ?? [];
const hasKind = (m: ChunkMeta, k: TrackInfo['kind']): boolean => initTracks(m).some((t) => t.kind === k);

const timeOrder = (a: ChunkMeta, b: ChunkMeta): number =>
  (a.startSec ?? Number.POSITIVE_INFINITY) === (b.startSec ?? Number.POSITIVE_INFINITY)
    ? a.seq - b.seq
    : (a.startSec ?? Number.POSITIVE_INFINITY) - (b.startSec ?? Number.POSITIVE_INFINITY);

/** The same segment appended again (a seek, a retry): keep the first copy. */
function dedupe(list: ChunkMeta[]): { kept: ChunkMeta[]; dropped: number } {
  const seen = new Set<string>();
  const kept: ChunkMeta[] = [];
  for (const m of list) {
    const key = m.startSec !== undefined ? `t${Math.round(m.startSec * 1000)}` : `s${m.sig}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(m);
  }
  return { kept, dropped: list.length - kept.length };
}

/**
 * Split a capture into parts. A new part starts whenever the video's initialisation segment changes (the player moved
 * to another quality): the two cannot share a file without re-encoding, and this never re-encodes. Audio, which
 * usually does not change, is placed in the part whose video covers its start time. Every part begins with the
 * initialisation segments it needs and holds each segment once, in time order.
 */
export function planParts(metas: readonly ChunkMeta[]): PartPlan {
  const byTrack = new Map<string, ChunkMeta[]>();
  for (const m of [...metas].sort((a, b) => a.seq - b.seq)) {
    const l = byTrack.get(m.track) ?? [];
    l.push(m);
    byTrack.set(m.track, l);
  }
  const roleOf = (list: ChunkMeta[]): PartTrack['role'] | undefined => {
    const init = [...list].reverse().find((m) => m.kind === 'init');
    if (!init) return undefined;
    const v = hasKind(init, 'video');
    const a = hasKind(init, 'audio');
    return v && a ? 'muxed' : v ? 'video' : a ? 'audio' : undefined;
  };
  const roles = new Map<string, PartTrack['role']>();
  for (const [t, l] of byTrack) {
    const r = roleOf(l);
    if (r) roles.set(t, r);
  }
  const bytesOf = (l: ChunkMeta[]) => l.filter((m) => m.kind === 'media').reduce((n, m) => n + m.length, 0);
  // The track that defines the parts: the video-bearing SourceBuffer with the most data.
  const primary = [...byTrack.entries()]
    .filter(([t]) => roles.get(t) === 'video' || roles.get(t) === 'muxed')
    .sort((a, b) => bytesOf(b[1]) - bytesOf(a[1]))[0];
  const orphanTracks = [...byTrack.entries()].filter(([t]) => !roles.has(t));
  let orphans = orphanTracks.reduce((n, [, l]) => n + l.filter((m) => m.kind === 'media').length, 0);
  let duplicates = 0;

  interface Draft {
    init: ChunkMeta;
    media: ChunkMeta[];
  }
  const drafts: Draft[] = [];
  const audioTracks = [...byTrack.entries()].filter(([t]) => roles.get(t) === 'audio');

  if (primary) {
    let cur: Draft | undefined;
    for (const m of primary[1]) {
      if (m.kind === 'init') {
        if (cur && cur.init.sig === m.sig) continue; // the same init appended again
        if (cur && cur.media.length === 0)
          cur.init = m; // nothing recorded under the previous one
        else {
          cur = { init: m, media: [] };
          drafts.push(cur);
        }
      } else if (cur) cur.media.push(m);
      else orphans++;
    }
  }

  const parts: Part[] = [];
  const starts = drafts.map((d) => Math.min(...d.media.map((m) => m.startSec ?? Number.POSITIVE_INFINITY)));
  drafts.forEach((d, i) => {
    if (d.media.length === 0) return;
    const d1 = dedupe([...d.media].sort(timeOrder));
    duplicates += d1.dropped;
    const startSec = Number.isFinite(starts[i]) ? (starts[i] as number) : 0;
    const nextStart = [...starts.slice(i + 1)].find((s) => Number.isFinite(s));
    const endSec = nextStart ?? Number.POSITIVE_INFINITY;
    const tracks: PartTrack[] = [
      {
        track: primary?.[0] as string,
        role: roles.get(primary?.[0] as string) as PartTrack['role'],
        chunks: [d.init, ...d1.kept],
      },
    ];
    for (const [t, list] of audioTracks) {
      const inits = list.filter((m) => m.kind === 'init');
      const media = list.filter((m) => m.kind === 'media');
      const mine = media.filter(
        (m) => (m.startSec ?? startSec) >= startSec && (m.startSec ?? startSec) < endSec,
      );
      if (mine.length === 0) continue;
      const first = Math.min(...mine.map((m) => m.seq));
      // the audio init in force when this part's first audio segment was appended
      const init = [...inits].reverse().find((m) => m.seq < first) ?? inits[0];
      if (!init) {
        orphans += mine.length;
        continue;
      }
      const d2 = dedupe([...mine].sort(timeOrder));
      duplicates += d2.dropped;
      tracks.push({ track: t, role: 'audio', chunks: [init, ...d2.kept] });
    }
    const videoInit = d.init;
    const part: Part = {
      index: parts.length,
      container: videoInit.container ?? 'mp4',
      startSec,
      endSec,
      tracks,
    };
    const v = initTracks(videoInit).find((t) => t.kind === 'video');
    if (v) part.video = v;
    const aInit =
      tracks.find((t) => t.role === 'audio')?.chunks[0] ??
      (roles.get(primary?.[0] as string) === 'muxed' ? videoInit : undefined);
    const a = aInit && initTracks(aInit).find((t) => t.kind === 'audio');
    if (a) part.audio = a;
    parts.push(part);
  });

  // Audio-only capture: no video-bearing SourceBuffer, one part per audio SourceBuffer
  if (!primary && audioTracks.length > 0) {
    const [t, list] = audioTracks.sort((a, b) => bytesOf(b[1]) - bytesOf(a[1]))[0] as [string, ChunkMeta[]];
    const init = list.find((m) => m.kind === 'init');
    const media = dedupe(list.filter((m) => m.kind === 'media').sort(timeOrder));
    duplicates += media.dropped;
    if (init && media.kept.length > 0) {
      const a = initTracks(init).find((x) => x.kind === 'audio');
      parts.push({
        index: 0,
        container: init.container ?? 'mp4',
        startSec: media.kept[0]?.startSec ?? 0,
        endSec: Number.POSITIVE_INFINITY,
        ...(a ? { audio: a } : {}),
        tracks: [{ track: t, role: 'audio', chunks: [init, ...media.kept] }],
      });
    }
  }
  return { parts, orphans, duplicates };
}
