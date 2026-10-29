/** Subtitle bytes: text encodings, TTML carried in MP4, segmented streams. Implemented in Rust (`core/src/subtitles.rs`). */
import type { Cue } from './subtitles';
import { core } from './core';

/** Decode subtitle bytes: UTF-8 when valid, otherwise Windows-1252 (the usual legacy encoding of SRT files). */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  return core.decodeSubtitleBytes(bytes);
}

/**
 * Payloads of the top-level `mdat` boxes of an ISO BMFF file. Subtitles carried in MP4 (IMSC1 `stpp`) keep their
 * XML document inside `mdat`. Malformed or truncated boxes end the walk; they never throw.
 */
export function mdatPayloads(data: Uint8Array): Uint8Array[] {
  const ranges = core.mdatRanges(data);
  const out: Uint8Array[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) out.push(data.subarray(ranges[i], ranges[i + 1]));
  return out;
}

/** Cues of one fetched subtitle resource: a text document, or an MP4 segment that carries TTML. */
export function cuesFromBytes(bytes: Uint8Array): Cue[] {
  return core.cuesFromBytes(bytes) as Cue[];
}

/**
 * Join the pieces of a segmented subtitle stream into one cue list. WebVTT pieces are placed using their
 * X-TIMESTAMP-MAP; other pieces carry absolute times. Repeated cues (segment overlap) are dropped.
 */
export function assembleCues(parts: Uint8Array[]): Cue[] {
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.byteLength;
  }
  return core.assembleCues(
    joined,
    Uint32Array.from(parts, (p) => p.byteLength),
  ) as Cue[];
}
