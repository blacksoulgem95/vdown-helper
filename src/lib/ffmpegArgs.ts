import type { AudioBitrate, AudioFormat, OutputMode } from '@/types/download';
import { core } from './core';

export interface FfmpegArgsInput {
  mode: OutputMode;
  /** Output extension, e.g. mp4, mkv, ts, mp3, m4a, aac, wav. */
  extension: string;
  video: 'copy' | 'transcode' | 'none';
  audio: 'copy' | 'transcode' | 'none';
  /** Path of the main input (video stream, or the only input). */
  videoPath: string;
  /** Path of a separate audio input to merge, if any. */
  audioPath?: string;
  audioFormat: AudioFormat;
  audioBitrate: AudioBitrate;
  /**
   * Keep the inputs' own timestamps, shifted together so the earliest starts at zero. Needed when two separately
   * recorded live tracks are joined: each began at a different moment, and that offset is the real A/V alignment.
   */
  keepOffsets?: boolean;
  output: string;
}

/**
 * Builds the FFmpeg command line. Video is only ever stream-copied (never re-encoded); audio is copied unless the plan
 * says otherwise. The planner (lib/compat) decides copy vs transcode; this just expresses it. Implemented in Rust
 * (`core/src/ffmpeg_args.rs`), shared with the desktop app.
 */
export function buildFfmpegArgs(i: FfmpegArgsInput): string[] {
  return core.buildFfmpegArgs(i);
}

export const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mka: 'audio/x-matroska',
  aac: 'audio/aac',
  wav: 'audio/wav',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ttml: 'application/ttml+xml',
};
