/**
 * Reading just enough of fragmented MP4 and WebM to organise what a player appends to a MediaSource: which chunks are
 * initialisation segments, what tracks they define, and where in time each media segment starts. Pure functions over
 * bytes; nothing is decoded or modified. Input comes from a hostile page, so every read is bounds-checked and the
 * parsers never throw: they return `undefined` for what they cannot make sense of.
 */
export type TrackKind = 'video' | 'audio' | 'other';
export type Container = 'mp4' | 'webm';

export interface TrackInfo {
  /** Track id inside the container. */
  id: number;
  kind: TrackKind;
  /** Sample entry (MP4: "avc1", "vp09", "mp4a", "Opus" ...) or CodecID (WebM: "V_VP9", "A_OPUS" ...). */
  codec: string;
  width?: number;
  height?: number;
  /** Ticks per second of the track's timestamps (MP4 mdhd; WebM: 1e9 / TimecodeScale). */
  timescale: number;
}

export interface InitInfo {
  container: Container;
  tracks: TrackInfo[];
}

export interface FragmentInfo {
  container: Container;
  /** Start of the first sample, per track, in the track's own ticks (WebM: Cluster Timecode, track 0 = all). */
  starts: Array<{ trackId: number; ticks: number }>;
}

const MAX_BOXES = 4096;

const u32 = (b: Uint8Array, o: number): number =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const u16 = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u64 = (b: Uint8Array, o: number): number => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

// ---------------------------------------------------------------------------------------------------------------
// ISO base media file format (fragmented MP4)

interface Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the box body (after the header) and its end, clamped to the buffer. */
  body: number;
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let pos = from;
  while (pos + 8 <= to && out.length < MAX_BOXES) {
    let size = u32(b, pos);
    const type = fourcc(b, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) break;
      size = u64(b, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || !Number.isFinite(size)) break;
    out.push({ type, start: pos, body: pos + header, end: Math.min(pos + size, to) });
    pos += size;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, type: string): Box | undefined =>
  boxes(b, parent.body, parent.end).find((x) => x.type === type);

function parseMp4Track(b: Uint8Array, trak: Box): TrackInfo | undefined {
  const tkhd = child(b, trak, 'tkhd');
  const mdia = child(b, trak, 'mdia');
  if (!tkhd || !mdia) return undefined;
  const id = u32(b, tkhd.body + ((b[tkhd.body] ?? 0) === 1 ? 20 : 12));
  const mdhd = child(b, mdia, 'mdhd');
  const hdlr = child(b, mdia, 'hdlr');
  if (!mdhd || !hdlr) return undefined;
  const timescale = u32(b, mdhd.body + ((b[mdhd.body] ?? 0) === 1 ? 20 : 12));
  const handler = fourcc(b, hdlr.body + 8);
  const kind: TrackKind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';
  let codec = '';
  let width: number | undefined;
  let height: number | undefined;
  const minf = child(b, mdia, 'minf');
  const stbl = minf && child(b, minf, 'stbl');
  const stsd = stbl && child(b, stbl, 'stsd');
  if (stsd && stsd.body + 8 + 8 <= stsd.end) {
    const entry = stsd.body + 8; // after version/flags and entry_count
    codec = fourcc(b, entry + 4);
    if (kind === 'video' && entry + 36 <= stsd.end) {
      width = u16(b, entry + 32);
      height = u16(b, entry + 34);
    }
  }
  if (!id || !timescale) return undefined;
  return { id, kind, codec, timescale, ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

function parseMp4Init(b: Uint8Array): InitInfo | undefined {
  const moov = boxes(b, 0, b.length).find((x) => x.type === 'moov');
  if (!moov) return undefined;
  const tracks = boxes(b, moov.body, moov.end)
    .filter((x) => x.type === 'trak')
    .map((t) => parseMp4Track(b, t))
    .filter((t): t is TrackInfo => t !== undefined);
  return tracks.length > 0 ? { container: 'mp4', tracks } : undefined;
}

function parseMp4Fragment(b: Uint8Array): FragmentInfo | undefined {
  const starts: FragmentInfo['starts'] = [];
  for (const moof of boxes(b, 0, b.length).filter((x) => x.type === 'moof')) {
    for (const traf of boxes(b, moof.body, moof.end).filter((x) => x.type === 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      const tfdt = child(b, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const version = b[tfdt.body] ?? 0;
      starts.push({
        trackId: u32(b, tfhd.body + 4),
        ticks: version === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4),
      });
    }
  }
  return starts.length > 0 ? { container: 'mp4', starts } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// WebM (Matroska subset)

interface Vint {
  value: number;
  length: number;
  /** Size field with all value bits set: "unknown size" (live-style segments and clusters). */
  unknown: boolean;
}

function vint(b: Uint8Array, pos: number, keepMarker: boolean): Vint | undefined {
  const first = b[pos];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
  if (length > 8 || pos + length > b.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = b[pos + i] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface Ebml {
  id: number;
  body: number;
  end: number;
}

function ebmlChildren(b: Uint8Array, from: number, to: number): Ebml[] {
  const out: Ebml[] = [];
  let pos = from;
  while (pos < to && out.length < MAX_BOXES) {
    const id = vint(b, pos, true);
    if (!id) break;
    const size = vint(b, pos + id.length, false);
    if (!size) break;
    const body = pos + id.length + size.length;
    const end = size.unknown ? to : Math.min(body + size.value, to);
    out.push({ id: id.value, body, end });
    if (size.unknown) break; // everything after it is inside it
    pos = end;
  }
  return out;
}

const uint = (b: Uint8Array, e: Ebml): number => {
  let v = 0;
  for (let i = e.body; i < e.end && i < e.body + 8; i++) v = v * 256 + (b[i] ?? 0);
  return v;
};
const str = (b: Uint8Array, e: Ebml): string =>
  String.fromCharCode(...b.subarray(e.body, Math.min(e.end, e.body + 40)));

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
} as const;

function parseWebmInit(b: Uint8Array): InitInfo | undefined {
  const top = ebmlChildren(b, 0, b.length);
  if (top[0]?.id !== ID.ebml) return undefined;
  const segment = top.find((e) => e.id === ID.segment);
  if (!segment) return undefined;
  const kids = ebmlChildren(b, segment.body, segment.end);
  const info = kids.find((e) => e.id === ID.info);
  const scaleEl = info && ebmlChildren(b, info.body, info.end).find((e) => e.id === ID.timecodeScale);
  const scaleNs = scaleEl ? uint(b, scaleEl) || 1_000_000 : 1_000_000;
  const tracksEl = kids.find((e) => e.id === ID.tracks);
  if (!tracksEl) return undefined;
  const tracks: TrackInfo[] = [];
  for (const entry of ebmlChildren(b, tracksEl.body, tracksEl.end).filter((e) => e.id === ID.trackEntry)) {
    const f = ebmlChildren(b, entry.body, entry.end);
    const get = (id: number) => f.find((e) => e.id === id);
    const number = get(ID.trackNumber);
    const type = get(ID.trackType);
    const codec = get(ID.codecId);
    const video = get(ID.video);
    const vf = video ? ebmlChildren(b, video.body, video.end) : [];
    const w = vf.find((e) => e.id === ID.pixelWidth);
    const h = vf.find((e) => e.id === ID.pixelHeight);
    tracks.push({
      id: number ? uint(b, number) : tracks.length + 1,
      kind: type ? (uint(b, type) === 1 ? 'video' : uint(b, type) === 2 ? 'audio' : 'other') : 'other',
      codec: codec ? str(b, codec) : '',
      timescale: 1e9 / scaleNs,
      ...(w ? { width: uint(b, w) } : {}),
      ...(h ? { height: uint(b, h) } : {}),
    });
  }
  return tracks.length > 0 ? { container: 'webm', tracks } : undefined;
}

function parseWebmFragment(b: Uint8Array): FragmentInfo | undefined {
  const cluster = ebmlChildren(b, 0, b.length).find((e) => e.id === ID.cluster);
  if (!cluster) return undefined;
  const tc = ebmlChildren(b, cluster.body, cluster.end).find((e) => e.id === ID.timecode);
  return tc ? { container: 'webm', starts: [{ trackId: 0, ticks: uint(b, tc) }] } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------

/** Initialisation segment (what the tracks are), or undefined if this chunk is not one. */
export function parseInit(data: Uint8Array): InitInfo | undefined {
  return parseMp4Init(data) ?? parseWebmInit(data);
}

/** Media segment (where it starts), or undefined if this chunk is not one. */
export function parseFragment(data: Uint8Array): FragmentInfo | undefined {
  return parseMp4Fragment(data) ?? parseWebmFragment(data);
}

/**
 * A player may append an initialisation segment and the first media segment in one call. Where the media starts inside
 * such a chunk (the first `moof` box, or the first WebM Cluster), or undefined when the chunk is not a mixture.
 */
export function mediaStartInInit(data: Uint8Array): number | undefined {
  const bs = boxes(data, 0, data.length);
  if (bs.some((x) => x.type === 'moov')) {
    const i = bs.findIndex((x) => x.type === 'moof');
    if (i < 0) return undefined;
    // a styp/sidx right before the moof belongs to the media segment
    let first = i;
    while (first > 0 && ['styp', 'sidx'].includes(bs[first - 1]?.type ?? '')) first--;
    const start = bs[first]?.start ?? 0;
    return start > 0 ? start : undefined;
  }
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    const segment = ebmlChildren(data, 0, data.length).find((e) => e.id === ID.segment);
    return segment ? firstClusterStart(data, segment.body) : undefined;
  }
  return undefined;
}

function firstClusterStart(b: Uint8Array, from: number): number | undefined {
  let pos = from;
  for (let n = 0; n < MAX_BOXES && pos < b.length; n++) {
    const id = vint(b, pos, true);
    if (!id) return undefined;
    const size = vint(b, pos + id.length, false);
    if (!size) return undefined;
    if (id.value === ID.cluster) return pos;
    if (size.unknown) return undefined;
    pos += id.length + size.length + size.value;
  }
  return undefined;
}
