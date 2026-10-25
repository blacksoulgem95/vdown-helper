import type { AudioBitrate, AudioFormat, OutputMode, VideoContainer } from '@/types/download';
import type { MediaFormat } from '@/types/media';
import { AUDIO_ONLY_FORMATS, type AudioFamily, type VideoFamily } from './media';

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
  | 'file-ffmpeg-copy';

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
}

const MP4_VIDEO: ReadonlySet<VideoFamily> = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);
const MP4_AUDIO: ReadonlySet<AudioFamily> = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac']);
const TS_VIDEO: ReadonlySet<VideoFamily> = new Set(['h264', 'hevc', 'mpeg4']);
const TS_AUDIO: ReadonlySet<AudioFamily> = new Set(['aac', 'mp3', 'ac3', 'eac3']);

/** Whether a video stream can be placed in `container` without re-encoding. Unknown codec = assume yes. */
export function videoFitsContainer(family: VideoFamily | undefined, container: Exclude<VideoContainer, 'original'>): boolean {
  if (!family || family === 'unknown') return true;
  if (container === 'mkv') return true;
  if (container === 'mp4') return MP4_VIDEO.has(family);
  return TS_VIDEO.has(family);
}

export function audioFitsContainer(family: AudioFamily | undefined, container: Exclude<VideoContainer, 'original'>): boolean {
  if (!family || family === 'unknown') return true;
  if (container === 'mkv') return true;
  if (container === 'mp4') return MP4_AUDIO.has(family);
  return TS_AUDIO.has(family);
}

export function audioExtension(format: AudioFormat): string {
  return format === 'm4a' ? 'm4a' : format;
}

/**
 * Pure planner: decides how a request would be fulfilled and whether it is allowed.
 * Rules: video is never re-encoded (stream copy only); audio may be transcoded; FFmpeg is only
 * required when the result cannot be produced by a native download or byte concatenation.
 */
export function planOutput(i: PlanInput): Plan {
  const issues: PlanIssue[] = [];
  const base: Plan = {
    valid: false,
    issues,
    pipeline: 'native',
    requiresFfmpeg: false,
    video: 'none',
    audio: 'none',
    extension: '',
    usesBitrate: false,
  };
  if (i.protectedStream) issues.push('protected');
  if (i.isHls && i.live) issues.push('live-stream');
  if (i.sourceFormat === 'dash' || i.sourceFormat === 'm3u' || i.sourceFormat === 'blob') issues.push('unsupported-source');
  if (issues.length) return base;

  const sourceIsAudioFile = !i.isHls && AUDIO_ONLY_FORMATS.has(i.sourceFormat);
  const hasAudioTrack = i.hasMuxedAudio || i.separateAudio || sourceIsAudioFile || (!i.isHls && i.hasVideo);

  // ---- Audio only
  if (i.mode === 'audio-only') {
    if (!hasAudioTrack) issues.push('no-audio-source');
    if (issues.length) return base;
    const copyable =
      i.audioFamily === 'aac' && (i.audioFormat === 'm4a' || i.audioFormat === 'aac');
    const alreadyThatFile = sourceIsAudioFile && i.sourceFormat === i.audioFormat;
    const transcode = !copyable;
    const plan: Plan = {
      ...base,
      requiresFfmpeg: !alreadyThatFile,
      pipeline: alreadyThatFile ? 'native' : transcode ? 'ffmpeg-transcode' : i.isHls ? 'hls-ffmpeg-copy' : 'file-ffmpeg-copy',
      audio: alreadyThatFile || copyable ? 'copy' : 'transcode',
      extension: audioExtension(i.audioFormat),
      usesBitrate: !alreadyThatFile && transcode && i.audioFormat !== 'wav',
    };
    return finalize(plan, i);
  }

  if (!i.hasVideo) {
    issues.push('no-video-source');
    return base;
  }

  // ---- Video only
  if (i.mode === 'video-only') {
    const needsRemux = i.container !== 'original';
    const target = i.container === 'original' ? undefined : i.container;
    if (target && !videoFitsContainer(i.videoFamily, target)) issues.push('video-codec-container');
    if (issues.length) return base;
    const hlsCopy = i.isHls;
    const ext = target ?? (i.isHls ? (i.fragmented ? 'mp4' : 'ts') : i.sourceFormat);
    // Muxed sources need FFmpeg to drop the audio; a native download would keep it.
    const mustStripAudio = i.hasMuxedAudio || (!i.isHls && !sourceIsAudioFile);
    return finalize(
      {
        ...base,
        requiresFfmpeg: needsRemux || mustStripAudio,
        pipeline: needsRemux || mustStripAudio ? (hlsCopy ? 'hls-ffmpeg-copy' : 'file-ffmpeg-copy') : 'native',
        video: 'copy',
        audio: 'none',
        extension: ext,
      },
      i,
    );
  }

  // ---- Original quality / Video + audio
  const wantsOriginal = i.mode === 'original' || i.container === 'original';
  const mergeNeeded = (i.mode === 'video-audio' || i.mode === 'original') && i.separateAudio;

  if (wantsOriginal && !mergeNeeded) {
    // Preserve the source container: nothing is re-encoded.
    const ext = i.isHls ? (i.fragmented ? 'mp4' : 'ts') : i.sourceFormat;
    return finalize(
      {
        ...base,
        pipeline: i.isHls ? 'hls-concat' : 'native',
        requiresFfmpeg: false,
        video: 'copy',
        audio: i.hasMuxedAudio || !i.isHls ? 'copy' : 'none',
        extension: ext,
      },
      i,
    );
  }

  const target: Exclude<VideoContainer, 'original'> =
    i.container === 'original' ? (i.fragmented ? 'mp4' : 'mkv') : i.container;
  if (!videoFitsContainer(i.videoFamily, target)) issues.push('video-codec-container');
  const audioOk = audioFitsContainer(i.audioFamily, target);
  if (issues.length) return base;
  const transcodeAudio = !audioOk && (i.hasMuxedAudio || i.separateAudio || !i.isHls);

  const sameContainerAsSource = !i.isHls && i.sourceFormat === target && !mergeNeeded;
  if (sameContainerAsSource) {
    return finalize({ ...base, pipeline: 'native', video: 'copy', audio: 'copy', extension: target }, i);
  }
  const concatOnly = i.isHls && !mergeNeeded && !transcodeAudio && target === 'ts' && !i.fragmented;
  if (concatOnly) {
    return finalize({ ...base, pipeline: 'hls-concat', video: 'copy', audio: i.hasMuxedAudio ? 'copy' : 'none', extension: 'ts' }, i);
  }
  return finalize(
    {
      ...base,
      requiresFfmpeg: true,
      pipeline: transcodeAudio ? 'ffmpeg-transcode' : i.isHls ? 'hls-ffmpeg-copy' : 'file-ffmpeg-copy',
      video: 'copy',
      audio: i.hasMuxedAudio || i.separateAudio || !i.isHls ? (transcodeAudio ? 'transcode' : 'copy') : 'none',
      extension: target,
      usesBitrate: transcodeAudio,
    },
    i,
  );
}

/** Applies resource limits and marks the plan valid when no issue remains. */
function finalize(plan: Plan, i: PlanInput): Plan {
  const issues = [...plan.issues];
  const limitBytes = i.limits.maxMemoryMb * 1024 * 1024;
  // Native downloads and plain concatenation are staged on disk; only FFmpeg holds its output in memory.
  if (plan.requiresFfmpeg && i.estimatedBytes !== undefined && i.estimatedBytes > limitBytes) {
    issues.push('too-large');
  }
  if (
    plan.requiresFfmpeg &&
    i.limits.maxEncodeDurationSec > 0 &&
    i.durationSec !== undefined &&
    i.durationSec > i.limits.maxEncodeDurationSec
  ) {
    issues.push('too-long-to-encode');
  }
  return { ...plan, issues, valid: issues.length === 0 };
}

/** Audio bitrate options that are meaningful for the given plan. Empty when the choice would have no effect. */
export function bitrateOptions(plan: Plan): AudioBitrate[] {
  return plan.usesBitrate ? [128, 192, 256, 320] : [];
}
