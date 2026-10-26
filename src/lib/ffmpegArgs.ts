import type { AudioBitrate, AudioFormat, OutputMode } from '@/types/download';

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
  output: string;
}

function audioCodecArgs(i: FfmpegArgsInput): string[] {
  if (i.audio === 'copy') return ['-c:a', 'copy'];
  switch (i.extension) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', `${i.audioBitrate}k`];
    case 'wav':
      return ['-c:a', 'pcm_s16le'];
    default:
      // m4a / aac, and re-encoding audio to fit a video container
      return ['-c:a', 'aac', '-b:a', `${i.audioBitrate}k`];
  }
}

/**
 * Builds the FFmpeg command line. Video is only ever stream-copied (never re-encoded); audio is copied unless
 * the plan says otherwise. The planner (lib/compat) decides copy vs transcode; this just expresses it.
 */
export function buildFfmpegArgs(i: FfmpegArgsInput): string[] {
  const args = ['-hide_banner', '-y'];
  if (i.mode === 'audio-only') {
    args.push('-i', i.audioPath ?? i.videoPath, '-vn', '-map', '0:a:0', ...audioCodecArgs(i));
    args.push(i.output);
    return args;
  }
  args.push('-i', i.videoPath);
  if (i.audioPath) args.push('-i', i.audioPath);
  args.push('-map', '0:v:0');
  if (i.audio === 'none') {
    args.push('-c:v', 'copy', '-an');
  } else {
    args.push('-map', i.audioPath ? '1:a:0' : '0:a:0?', '-c:v', 'copy', ...audioCodecArgs(i));
  }
  if (i.extension === 'mp4' || i.extension === 'm4a') args.push('-movflags', '+faststart');
  args.push(i.output);
  return args;
}

export const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
};
