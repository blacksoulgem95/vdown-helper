/** Media formats, labels, titles and codec descriptions. Implemented in Rust (`core/src/media.rs`). */
import type { MediaFormat } from '@/types/media';
import { core } from './core';

export function formatBytes(bytes: number | undefined): string {
  return core.formatBytes(bytes);
}

export function formatDuration(seconds: number | undefined): string {
  return core.formatDuration(seconds);
}

export function formatBitrate(bitsPerSecond: number | undefined): string {
  return core.formatBitrate(bitsPerSecond);
}

export function formatSpeed(bytesPerSecond: number | undefined): string {
  return core.formatSpeed(bytesPerSecond);
}

/** Resolution tier derived from the *actual* pixel height. Used only to label variants that exist. */
export function qualityTag(height: number | undefined): string {
  return core.qualityTag(height);
}

export function resolutionLabel(height: number | undefined, width?: number): string {
  return core.resolutionLabel(height, width);
}

export function formatFromMime(mime: string | undefined): MediaFormat | undefined {
  return core.formatFromMime(mime) as MediaFormat | undefined;
}

export function extensionOf(url: string): string {
  return core.extensionOf(url);
}

export function formatFromUrl(url: string): MediaFormat | undefined {
  return core.formatFromUrl(url) as MediaFormat | undefined;
}

/** Subtitle documents that are saved or converted as text (data; held to the core by tests/core-golden). */
export const SUBTITLE_FILE_FORMATS: ReadonlySet<MediaFormat> = new Set(['vtt', 'srt', 'ttml']);

export const AUDIO_ONLY_FORMATS: ReadonlySet<MediaFormat> = new Set([
  'mp3',
  'm4a',
  'aac',
  'wav',
  'ogg',
  'flac',
  'opus',
  'aiff',
  'wma',
]);

export const VIDEO_FORMATS: ReadonlySet<MediaFormat> = new Set([
  'mp4',
  'webm',
  'mkv',
  'mov',
  'ogv',
  'ts',
  'flv',
  'avi',
  'wmv',
  'asf',
  '3gp',
  'mpg',
  'hls',
]);

export function mediaTypeOf(format: MediaFormat): 'video' | 'audio' | 'unknown' {
  return core.mediaTypeOf(format) as 'video' | 'audio' | 'unknown';
}

/** Best-effort title from explicit title, page title, or the URL's last path segment. */
export function inferTitle(opts: { url: string; elementTitle?: string; pageTitle?: string }): string {
  return core.inferTitle(opts.url, opts.elementTitle, opts.pageTitle);
}

export type VideoFamily = 'h264' | 'hevc' | 'av1' | 'vp9' | 'vp8' | 'mpeg4' | 'unknown';
export type AudioFamily = 'aac' | 'mp3' | 'ac3' | 'eac3' | 'opus' | 'vorbis' | 'flac' | 'unknown';

export interface CodecInfo {
  video?: { family: VideoFamily; label: string };
  audio?: { family: AudioFamily; label: string };
}

export function describeCodecs(codecs: string | undefined): CodecInfo {
  return core.describeCodecs(codecs) as CodecInfo;
}

/** bits/s x seconds -> bytes. Callers must label the result as an estimate. */
export function estimateBytes(
  bitsPerSecond: number | undefined,
  durationSec: number | undefined,
): number | undefined {
  return core.estimateBytes(bitsPerSecond, durationSec);
}
