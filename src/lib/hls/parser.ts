import type {
  HlsByteRange,
  HlsError,
  HlsKey,
  HlsMap,
  HlsMasterPlaylist,
  HlsMediaPlaylist,
  HlsParseResult,
  HlsRendition,
  HlsSegment,
  HlsVariant,
  KeyMethod,
  PlaylistClass,
  RenditionType,
} from '@/types/hls';
import { MAX_URL_LENGTH, isSafeFetchUrl, parseUrl } from '../security';

/** The most segments a playlist may list (the segment engine has the same limit). */
const MAX_SEGMENTS = 20_000;
import { parseAttributes, parseNumber, parseResolution } from './attributes';

const MEDIA_TAGS = [
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-ENDLIST',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-BYTERANGE',
  '#EXT-X-MAP',
  '#EXT-X-KEY',
  '#EXT-X-DISCONTINUITY',
];
const MASTER_TAGS = ['#EXT-X-STREAM-INF', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-SESSION-KEY'];

function cleanLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim());
}

/**
 * Decide what kind of playlist-like document `text` is.
 *  - hls-master / hls-media: valid HLS markers present
 *  - m3u-plain: an ordinary M3U/M3U8 list (audio list, IPTV list) with no HLS semantics
 *  - dash: an MPEG-DASH MPD document
 *  - unsupported: anything else
 */
export function classifyPlaylist(text: string): PlaylistClass {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (/^<\?xml|^<MPD[\s>]/i.test(head) && /<MPD[\s>]/i.test(head.slice(0, 4096))) return 'dash';
  if (!head.startsWith('#EXTM3U')) return 'unsupported';
  const lines = cleanLines(head);
  const has = (tags: string[]) => lines.some((l) => tags.some((t) => l === t || l.startsWith(`${t}:`)));
  if (has(MASTER_TAGS) || lines.some((l) => l.startsWith('#EXT-X-MEDIA:'))) return 'hls-master';
  if (has(MEDIA_TAGS)) return 'hls-media';
  return 'm3u-plain';
}

function fail(code: HlsError['code'], message: string, line?: number): HlsParseResult {
  return { ok: false, error: line === undefined ? { code, message } : { code, message, line } };
}

function resolveUri(uri: string, base: string): string | undefined {
  // Each relative line is resolved against the playlist's own address: a long base would multiply into every segment.
  if (uri.length > MAX_URL_LENGTH || base.length > MAX_URL_LENGTH) return undefined;
  const url = parseUrl(uri, base);
  if (!url) return undefined;
  const href = url.toString();
  return isSafeFetchUrl(href) ? href : undefined;
}

interface RawByteRange {
  length: number;
  /** Absent when the range continues from the previous range of the same resource. */
  offset?: number;
}

function parseByteRange(value: string): RawByteRange | undefined {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!m) return undefined;
  const raw: RawByteRange = { length: Number(m[1]) };
  if (m[2] !== undefined) raw.offset = Number(m[2]);
  return raw;
}

const DRM_KEYFORMATS_ALLOWED = new Set(['identity', '']);

function parseKey(attrs: Record<string, string>, base: string): HlsKey | undefined {
  const rawMethod = (attrs['METHOD'] ?? '').toUpperCase();
  const method: KeyMethod =
    rawMethod === 'NONE' ||
    rawMethod === 'AES-128' ||
    rawMethod === 'SAMPLE-AES' ||
    rawMethod === 'SAMPLE-AES-CTR'
      ? rawMethod
      : 'UNKNOWN';
  if (method === 'NONE') return undefined;
  const keyFormat = (attrs['KEYFORMAT'] ?? 'identity').toLowerCase();
  const uriRaw = attrs['URI'];
  const uri = uriRaw ? resolveUri(uriRaw, base) : undefined;
  const key: HlsKey = {
    method,
    keyFormat,
    // Only plain AES-128 with the identity key format is decryptable by a regular client.
    // Only plain AES-128 with the identity key format and a fetchable http(s) key can be decrypted by a normal client.
    protectedByDrm: method !== 'AES-128' || !DRM_KEYFORMATS_ALLOWED.has(keyFormat) || !uri,
  };
  if (uri) key.uri = uri;
  if (attrs['IV']) key.iv = attrs['IV'];
  return key;
}

function parseMaster(lines: string[], url: string): HlsParseResult {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  const sessionKeys: HlsKey[] = [];
  let version: number | undefined;
  let iFrameStreams = 0;
  let pending: Record<string, string> | undefined;
  let pendingLine = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? '';
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) {
      version = parseNumber(line.slice('#EXT-X-VERSION:'.length));
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      pendingLine = idx + 1;
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      iFrameStreams++;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = (a['TYPE'] ?? '').toUpperCase() as RenditionType;
      if (!['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(type)) continue;
      const uri = a['URI'] ? resolveUri(a['URI'], url) : undefined;
      if (a['URI'] && !uri) return fail('unsafe-url', 'Rendition URI uses a disallowed scheme', idx + 1);
      const r: HlsRendition = {
        type,
        groupId: a['GROUP-ID'] ?? '',
        name: a['NAME'] ?? a['LANGUAGE'] ?? type,
        isDefault: (a['DEFAULT'] ?? '').toUpperCase() === 'YES',
        autoSelect: (a['AUTOSELECT'] ?? '').toUpperCase() === 'YES',
      };
      if (a['LANGUAGE']) r.language = a['LANGUAGE'];
      if (uri) r.uri = uri;
      if (a['CHANNELS']) r.channels = a['CHANNELS'];
      renditions.push(r);
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const k = parseKey(parseAttributes(line.slice('#EXT-X-SESSION-KEY:'.length)), url);
      if (k) sessionKeys.push(k);
    } else if (!line.startsWith('#')) {
      if (!pending) continue; // stray URI without STREAM-INF: ignore
      const bandwidth = parseNumber(pending['BANDWIDTH']);
      if (bandwidth === undefined || bandwidth <= 0) {
        return fail('malformed', 'EXT-X-STREAM-INF is missing a valid BANDWIDTH', pendingLine);
      }
      const uri = resolveUri(line, url);
      if (!uri) return fail('unsafe-url', 'Variant URI is invalid or uses a disallowed scheme', idx + 1);
      const v: HlsVariant = { uri, bandwidth };
      const avg = parseNumber(pending['AVERAGE-BANDWIDTH']);
      if (avg !== undefined) v.averageBandwidth = avg;
      const res = parseResolution(pending['RESOLUTION']);
      if (res) {
        v.width = res.width;
        v.height = res.height;
      }
      const fr = parseNumber(pending['FRAME-RATE']);
      if (fr !== undefined) v.frameRate = fr;
      if (pending['CODECS']) v.codecs = pending['CODECS'];
      if (pending['VIDEO-RANGE']) v.videoRange = pending['VIDEO-RANGE'];
      if (pending['AUDIO']) v.audioGroup = pending['AUDIO'];
      if (pending['SUBTITLES']) v.subtitleGroup = pending['SUBTITLES'];
      variants.push(v);
      pending = undefined;
    }
  }

  if (variants.length === 0 && renditions.every((r) => !r.uri)) {
    return fail('malformed', 'Master playlist declares no playable variants');
  }
  // Highest resolution first, then bandwidth.
  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);
  const playlist: HlsMasterPlaylist = {
    kind: 'hls-master',
    url,
    variants,
    renditions,
    iFrameStreams,
    sessionKeys,
  };
  if (version !== undefined) playlist.version = version;
  return { ok: true, playlist };
}

function parseMedia(lines: string[], url: string): HlsParseResult {
  const segments: HlsSegment[] = [];
  let version: number | undefined;
  let targetDuration: number | undefined;
  let mediaSequence = 0;
  let playlistType: 'VOD' | 'EVENT' | undefined;
  let endList = false;
  let currentKey: HlsKey | undefined;
  let currentMap: HlsMap | undefined;
  let pendingDuration: number | undefined;
  let pendingTitle: string | undefined;
  let pendingRange: RawByteRange | undefined;
  let discontinuity = false;
  let lastRangeEnd: number | undefined;
  let lastRangeUri: string | undefined;
  const encryption = new Set<KeyMethod>();
  let hasDrm = false;
  let fragmented = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? '';
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) version = parseNumber(line.slice(15));
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseNumber(line.slice(22));
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = parseNumber(line.slice(22)) ?? 0;
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const t = line.slice(21).trim().toUpperCase();
      if (t === 'VOD' || t === 'EVENT') playlistType = t;
    } else if (line === '#EXT-X-ENDLIST') endList = true;
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line.startsWith('#EXT-X-KEY:')) {
      currentKey = parseKey(parseAttributes(line.slice(11)), url);
      if (currentKey) {
        encryption.add(currentKey.method);
        if (currentKey.protectedByDrm) hasDrm = true;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      const uriRaw = a['URI'];
      if (!uriRaw) return fail('malformed', 'EXT-X-MAP without URI', idx + 1);
      const uri = resolveUri(uriRaw, url);
      if (!uri) return fail('unsafe-url', 'Init-section URI is invalid or uses a disallowed scheme', idx + 1);
      const map: HlsMap = { uri };
      if (currentKey) map.key = currentKey;
      if (a['BYTERANGE']) {
        const br = parseByteRange(a['BYTERANGE']);
        if (br) map.byteRange = { length: br.length, offset: br.offset ?? 0 };
      }
      currentMap = map;
      fragmented = true;
    } else if (line.startsWith('#EXTINF:')) {
      const rest = line.slice(8);
      const comma = rest.indexOf(',');
      const dur = parseNumber((comma === -1 ? rest : rest.slice(0, comma)).trim());
      if (dur === undefined || dur < 0) return fail('malformed', 'EXTINF has an invalid duration', idx + 1);
      pendingDuration = dur;
      const title = comma === -1 ? '' : rest.slice(comma + 1).trim();
      pendingTitle = title || undefined;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17));
      if (!pendingRange) return fail('malformed', 'EXT-X-BYTERANGE is invalid', idx + 1);
    } else if (!line.startsWith('#')) {
      if (pendingDuration === undefined) continue; // URI without EXTINF: not a segment
      const uri = resolveUri(line, url);
      if (!uri) return fail('unsafe-url', 'Segment URI is invalid or uses a disallowed scheme', idx + 1);
      const seg: HlsSegment = {
        uri,
        duration: pendingDuration,
        sequence: mediaSequence + segments.length,
        discontinuity,
      };
      if (pendingTitle) seg.title = pendingTitle;
      if (pendingRange) {
        // Without an explicit offset the range continues from the previous range of the same resource.
        const offset = pendingRange.offset ?? (lastRangeUri === uri ? (lastRangeEnd ?? 0) : 0);
        const range: HlsByteRange = { length: pendingRange.length, offset };
        seg.byteRange = range;
        lastRangeEnd = offset + range.length;
        lastRangeUri = uri;
      }
      if (currentKey) seg.key = currentKey;
      if (currentMap) seg.map = currentMap;
      if (segments.length >= MAX_SEGMENTS) return fail('malformed', 'The playlist lists too many segments');
      segments.push(seg);
      pendingDuration = undefined;
      pendingTitle = undefined;
      pendingRange = undefined;
      discontinuity = false;
    }
  }

  if (segments.length === 0) return fail('malformed', 'Media playlist contains no segments');
  const playlist: HlsMediaPlaylist = {
    kind: 'hls-media',
    url,
    mediaSequence,
    endList,
    segments,
    totalDuration: segments.reduce((s, x) => s + x.duration, 0),
    encryption: [...encryption],
    hasDrm,
    fragmented,
  };
  if (version !== undefined) playlist.version = version;
  if (targetDuration !== undefined) playlist.targetDuration = targetDuration;
  if (playlistType) playlist.playlistType = playlistType;
  return { ok: true, playlist };
}

/** Parse an HLS playlist. Never throws; failures are returned as typed errors. */
export function parseHls(text: string, url: string): HlsParseResult {
  if (!text || !text.trim()) return fail('empty', 'The playlist is empty');
  const cls = classifyPlaylist(text);
  if (cls === 'dash') return fail('dash', 'This is an MPEG-DASH manifest, which is not supported');
  if (cls === 'unsupported') return fail('not-m3u', 'The document is not an M3U playlist');
  if (cls === 'm3u-plain') return fail('not-hls', 'This is an ordinary M3U playlist, not an HLS manifest');
  const lines = cleanLines(text);
  try {
    return cls === 'hls-master' ? parseMaster(lines, url) : parseMedia(lines, url);
  } catch (e) {
    return fail('malformed', e instanceof Error ? e.message : 'Unexpected parse failure');
  }
}
