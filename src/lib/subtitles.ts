/**
 * Subtitle documents (WebVTT, SRT, TTML) read into cues and written back as SRT or WebVTT. Implemented in Rust
 * (`core/src/subtitles.rs`).
 */
import { core } from './core';

/** A single caption. Times are seconds on the media timeline. */
export interface Cue {
  start: number;
  end: number;
  /** Plain text with `<b>`/`<i>`/`<u>` kept (SRT-compatible); lines separated by "\n". */
  text: string;
}

export type SubtitleFormat = 'vtt' | 'srt' | 'ttml' | 'unknown';

/** Best guess of what a document is, from its content (never from its name). */
export function detectSubtitleFormat(text: string): SubtitleFormat {
  return core.detectSubtitleFormat(text) as SubtitleFormat;
}

/** "01:02:03.456", "02:03.456" or SRT's "01:02:03,456" to seconds. */
export function parseTimestamp(value: string): number | undefined {
  return core.parseTimestamp(value);
}

export function parseVtt(text: string): Cue[] {
  return core.parseVtt(text) as Cue[];
}

/** The `X-TIMESTAMP-MAP` of a WebVTT segment: seconds to add to cue times to get media (MPEG-TS) time. */
export function timestampMapOffset(text: string): number | undefined {
  return core.timestampMapOffset(text);
}

/**
 * Join the segments of an HLS WebVTT subtitle playlist into one cue list. With X-TIMESTAMP-MAP the cues are moved
 * onto the media timeline and shifted so the earliest segment starts at zero; without it cue times are already
 * absolute (per RFC 8216). Cues repeated at segment boundaries are removed.
 */
export function stitchVttSegments(segments: string[]): Cue[] {
  return core.stitchVttSegments(segments) as Cue[];
}

export function parseTtml(text: string): Cue[] {
  return core.parseTtml(text) as Cue[];
}

export function formatSrt(cues: Cue[]): string {
  return core.formatSrt(cues);
}

export function formatVtt(cues: Cue[]): string {
  return core.formatVtt(cues);
}

/** Parse any supported subtitle document into cues (SRT is parsed through the VTT reader: same layout). */
export function parseSubtitles(text: string): { format: SubtitleFormat; cues: Cue[] } {
  return core.parseSubtitles(text) as { format: SubtitleFormat; cues: Cue[] };
}

export function toSrt(text: string): string | undefined {
  return core.toSrt(text);
}
