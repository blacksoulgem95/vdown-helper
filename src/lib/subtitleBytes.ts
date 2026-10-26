import { parseSubtitles, parseTtml, stitchVttSegments, detectSubtitleFormat, type Cue } from './subtitles';

const MAX_CUES = 100_000;

/** Decode subtitle bytes: UTF-8 when valid, otherwise Windows-1252 (the usual legacy encoding of SRT files). */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Payloads of the top-level `mdat` boxes of an ISO BMFF file. Subtitles carried in MP4 (IMSC1 `stpp`) keep their
 * XML document inside `mdat`. Malformed or truncated boxes end the walk; they never throw.
 */
export function mdatPayloads(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  while (pos + 8 <= data.byteLength) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > data.byteLength) break;
      const big = view.getBigUint64(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = data.byteLength - pos; // the box runs to the end of the file
    }
    if (size < header) break;
    const end = Math.min(pos + size, data.byteLength);
    if (type === 'mdat') out.push(data.subarray(pos + header, end));
    pos += size;
  }
  return out;
}

/** An `mdat` can hold several concatenated TTML documents (one per sample). */
function splitTtmlDocuments(text: string): string[] {
  return text
    .split(/(?<=<\/(?:[A-Za-z0-9_-]+:)?tt>)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Cues of one fetched subtitle resource: a text document, or an MP4 segment that carries TTML. */
export function cuesFromBytes(bytes: Uint8Array): Cue[] {
  const text = decodeSubtitleBytes(bytes.subarray(0, Math.min(bytes.byteLength, 2048)));
  if (detectSubtitleFormat(text) !== 'unknown') return parseSubtitles(decodeSubtitleBytes(bytes)).cues;
  const cues: Cue[] = [];
  for (const payload of mdatPayloads(bytes)) {
    for (const doc of splitTtmlDocuments(decodeSubtitleBytes(payload))) cues.push(...parseTtml(doc));
  }
  return cues;
}

/**
 * Join the pieces of a segmented subtitle stream into one cue list. WebVTT pieces are placed using their
 * X-TIMESTAMP-MAP; other pieces carry absolute times. Repeated cues (segment overlap) are dropped.
 */
export function assembleCues(parts: Uint8Array[]): Cue[] {
  const texts = parts.map((p) => decodeSubtitleBytes(p.subarray(0, Math.min(p.byteLength, 64))));
  if (
    parts.length > 0 &&
    texts.every((t) =>
      t
        .replace(/^\uFEFF/, '')
        .trimStart()
        .startsWith('WEBVTT'),
    )
  ) {
    return stitchVttSegments(parts.map(decodeSubtitleBytes));
  }
  const seen = new Set<string>();
  const out: Cue[] = [];
  for (const part of parts) {
    for (const c of cuesFromBytes(part)) {
      const key = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end).slice(0, MAX_CUES);
}
