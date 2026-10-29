import type { AudioBitrate, AudioFormat, OutputMode, VideoContainer } from '@/types/download';
import type { MediaFormat } from '@/types/media';
import type { AudioFamily, VideoFamily } from './media';
import { core } from './core';

/** Machine-readable problems; the UI maps these to localised messages. */
export type PlanIssue =
  | 'no-audio-source'
  | 'no-video-source'
  | 'video-codec-container'
  | 'audio-codec-container'
  | 'container-needs-ffmpeg'
  | 'separate-audio-needs-ffmpeg'
  | 'audio-extract-needs-ffmpeg'
  | 'bitrate-not-applicable'
  | 'too-large'
  | 'too-long-to-encode'
  | 'protected'
  | 'live-stream'
  | 'unsupported-source';

/**
 * Not a reason to refuse, only something the user should know before starting. 'large-for-memory': the conversion
 * runs in browser memory and may not fit; if it does not, the stream is saved as it was downloaded (nothing is lost).
 */
export type PlanWarning = 'large-for-memory';

export type Pipeline =
  /** Chrome downloads the URL itself. */
  | 'native'
  /** Segments are fetched and concatenated byte-for-byte, no FFmpeg. */
  | 'hls-concat'
  /** Segments fetched, then FFmpeg remuxes/merges with stream copy only. */
  | 'hls-ffmpeg-copy'
  /** FFmpeg is needed and at least one stream is re-encoded (audio only; video is never re-encoded). */
  | 'ffmpeg-transcode'
  /** A single non-HLS file is passed through FFmpeg with stream copy. */
  | 'file-ffmpeg-copy'
  /**
   * A plain file fetched by the extension itself (so the owning frame's Referer/Origin can be replayed), staged on
   * disk and then saved. Never chosen by the planner: only used as a fallback when Chrome's download manager is refused.
   */
  | 'file-staged'
  /** A subtitle fetched, stitched and/or converted in the offscreen document (lib/subtitles). */
  | 'subtitle'
  /** Plain files fetched one by one and packed into a ZIP written to disk (lib/zip). */
  | 'zip'
  /** A MediaSource player recorded in the page, assembled into one or more files by copying streams (no re-encode). */
  | 'capture'
  /** A MediaStream recorded in the page until Stop, saved as WebM or MP4 (no re-encode of what the recorder wrote). */
  | 'record'
  /** A live or event stream (HLS, DASH dynamic) recorded by the extension until Stop, the end of the stream or a limit. */
  | 'live';

export type StreamHandling = 'copy' | 'transcode';

export interface PlanInput {
  isHls: boolean;
  /** For HLS: true when segments are fMP4 (init map), false for MPEG-TS. */
  fragmented?: boolean;
  sourceFormat: MediaFormat;
  videoFamily?: VideoFamily;
  audioFamily?: AudioFamily;
  /** The variant playlist carries audio itself (no separate rendition required). */
  hasMuxedAudio: boolean;
  /** A separate audio rendition has been selected. */
  separateAudio: boolean;
  /** The source stream has a video track at all. */
  hasVideo: boolean;
  mode: OutputMode;
  container: VideoContainer;
  audioFormat: AudioFormat;
  audioBitrate: AudioBitrate;
  estimatedBytes?: number;
  durationSec?: number;
  live?: boolean;
  protectedStream?: boolean;
  limits: { maxMemoryMb: number; maxEncodeDurationSec: number };
}

export interface Plan {
  valid: boolean;
  issues: PlanIssue[];
  pipeline: Pipeline;
  requiresFfmpeg: boolean;
  /** Per-track handling, only meaningful when valid. */
  video: StreamHandling | 'none';
  audio: StreamHandling | 'none';
  /** The target container/extension of the produced file. */
  extension: string;
  /** Whether an audio bitrate choice affects the result. */
  usesBitrate: boolean;
  warnings?: PlanWarning[];
}

/** Whether a video stream can be placed in `container` without re-encoding. Unknown codec = assume yes. */
export function videoFitsContainer(
  family: VideoFamily | undefined,
  container: Exclude<VideoContainer, 'original'>,
): boolean {
  return core.videoFitsContainer(family, container);
}

export function audioFitsContainer(
  family: AudioFamily | undefined,
  container: Exclude<VideoContainer, 'original'>,
): boolean {
  return core.audioFitsContainer(family, container);
}

/**
 * Containers a plain file of this format may be copied into without re-encoding its video. Legacy formats usually hold
 * codecs MP4 cannot carry (WMV/VC-1, MPEG-1/2, old AVI codecs), so those are only offered as a Matroska copy or kept.
 */
export function sourceFitsContainer(
  format: MediaFormat,
  container: Exclude<VideoContainer, 'original'>,
): boolean {
  return core.sourceFitsContainer(format, container);
}

/** File extension for a source format. Unknown sources get none: Chrome names them from the response instead. */
export function fileExtension(format: MediaFormat): string {
  return core.fileExtension(format);
}

export function audioExtension(format: AudioFormat): string {
  return core.audioExtension(format);
}

/**
 * Pure planner: decides how a request would be fulfilled and whether it is allowed. Rules: video is never re-encoded
 * (stream copy only); audio may be transcoded; FFmpeg is only required when the result cannot be produced by a native
 * download or byte concatenation. Implemented in Rust (`core/src/compat.rs`), shared with the desktop app.
 */
export function planOutput(i: PlanInput): Plan {
  return core.planOutput(i) as Plan;
}

/** Audio bitrate options that are meaningful for the given plan. Empty when the choice would have no effect. */
export function bitrateOptions(plan: Plan): AudioBitrate[] {
  return core.bitrateOptions(plan) as AudioBitrate[];
}
