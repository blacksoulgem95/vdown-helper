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
  | 'capture';

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
export function videoFitsContainer(
  family: VideoFamily | undefined,
  container: Exclude<VideoContainer, 'original'>,
): boolean {
  if (!family || family === 'unknown') return true;
  if (container === 'mkv') return true;
  if (container === 'mp4') return MP4_VIDEO.has(family);
  return TS_VIDEO.has(family);
}

export function audioFitsContainer(
  family: AudioFamily | undefined,
  container: Exclude<VideoContainer, 'original'>,
): boolean {
  if (!family || family === 'unknown') return true;
  if (container === 'mkv') return true;
  if (container === 'mp4') return MP4_AUDIO.has(family);
  return TS_AUDIO.has(family);
}

/**
 * Containers a plain file of this format may be copied into without re-encoding its video. Legacy formats usually hold
 * codecs MP4 cannot carry (WMV/VC-1, MPEG-1/2, old AVI codecs), and the planner never re-encodes video, so those are
 * only offered as a Matroska copy (which takes nearly anything) or kept as they are. A source not listed here is not
 * restricted. Codecs inside a direct file are not known up front, so this is a property of the format.
 */
const REMUX_TARGETS: Partial<Record<MediaFormat, ReadonlySet<Exclude<VideoContainer, 'original'>>>> = {
  flv: new Set(['mp4', 'mkv', 'ts']),
  avi: new Set(['mkv']),
  wmv: new Set(['mkv']),
  asf: new Set(['mkv']),
  mpg: new Set(['mkv', 'ts']),
  '3gp': new Set(['mp4', 'mkv']),
};

export function sourceFitsContainer(
  format: MediaFormat,
  container: Exclude<VideoContainer, 'original'>,
): boolean {
  return REMUX_TARGETS[format]?.has(container) ?? true;
}

/** File extension for a source format. Unknown sources get none: Chrome names them from the response instead. */
export function fileExtension(format: MediaFormat): string {
  return format === 'unknown' || format === 'blob' || format === 'm3u' || format === 'dash' ? '' : format;
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
  if (i.sourceFormat === 'dash' || i.sourceFormat === 'm3u' || i.sourceFormat === 'blob')
    issues.push('unsupported-source');
  if (issues.length) return base;

  const sourceIsAudioFile = !i.isHls && AUDIO_ONLY_FORMATS.has(i.sourceFormat);
  const hasAudioTrack = i.hasMuxedAudio || i.separateAudio || sourceIsAudioFile || (!i.isHls && i.hasVideo);

  // ---- Audio only
  if (i.mode === 'audio-only') {
    if (!hasAudioTrack) issues.push('no-audio-source');
    if (issues.length) return base;
    const copyable = i.audioFamily === 'aac' && (i.audioFormat === 'm4a' || i.audioFormat === 'aac');
    const alreadyThatFile = sourceIsAudioFile && i.sourceFormat === i.audioFormat;
    const transcode = !copyable;
    const plan: Plan = {
      ...base,
      requiresFfmpeg: !alreadyThatFile,
      pipeline: alreadyThatFile
        ? 'native'
        : transcode
          ? 'ffmpeg-transcode'
          : i.isHls
            ? 'hls-ffmpeg-copy'
            : 'file-ffmpeg-copy',
      audio: alreadyThatFile || copyable ? 'copy' : 'transcode',
      extension: audioExtension(i.audioFormat),
      usesBitrate: !alreadyThatFile && transcode && i.audioFormat !== 'wav',
    };
    return finalize(plan, i);
  }

  // ---- An audio-only source kept as it is (an .mp3 link, an audio-only HLS rendition): nothing to convert.
  if (!i.hasVideo && i.mode === 'original') {
    if (!hasAudioTrack) issues.push('no-audio-source');
    if (issues.length) return base;
    return finalize(
      i.isHls
        ? { ...base, pipeline: 'hls-concat', audio: 'copy', extension: i.fragmented ? 'm4a' : 'ts' }
        : { ...base, pipeline: 'native', audio: 'copy', extension: fileExtension(i.sourceFormat) },
      i,
    );
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
    if (target && !i.isHls && !sourceFitsContainer(i.sourceFormat, target))
      issues.push('video-codec-container');
    if (issues.length) return base;
    const hlsCopy = i.isHls;
    const ext = target ?? (i.isHls ? (i.fragmented ? 'mp4' : 'ts') : fileExtension(i.sourceFormat));
    // Muxed sources need FFmpeg to drop the audio; a native download would keep it.
    const mustStripAudio = i.hasMuxedAudio || (!i.isHls && !sourceIsAudioFile);
    return finalize(
      {
        ...base,
        requiresFfmpeg: needsRemux || mustStripAudio,
        pipeline:
          needsRemux || mustStripAudio ? (hlsCopy ? 'hls-ffmpeg-copy' : 'file-ffmpeg-copy') : 'native',
        video: 'copy',
        audio: 'none',
        extension: ext,
      },
      i,
    );
  }

  // ---- Original quality / Video + audio
  // The container choice decides: 'original' keeps the source container, anything else is a stream-copy remux.
  const wantsOriginal = i.container === 'original';
  const mergeNeeded = (i.mode === 'video-audio' || i.mode === 'original') && i.separateAudio;

  if (wantsOriginal && !mergeNeeded) {
    // Preserve the source container: nothing is re-encoded.
    const ext = i.isHls ? (i.fragmented ? 'mp4' : 'ts') : fileExtension(i.sourceFormat);
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

  // "Original" with a merge: MP4 when both codecs fit it (widest compatibility), otherwise Matroska.
  const target: Exclude<VideoContainer, 'original'> =
    i.container === 'original'
      ? videoFitsContainer(i.videoFamily, 'mp4') && audioFitsContainer(i.audioFamily, 'mp4')
        ? 'mp4'
        : 'mkv'
      : i.container;
  if (!videoFitsContainer(i.videoFamily, target)) issues.push('video-codec-container');
  if (!i.isHls && !sourceFitsContainer(i.sourceFormat, target)) issues.push('video-codec-container');
  const audioOk = audioFitsContainer(i.audioFamily, target);
  // "Original quality" promises no re-encoding at all, so a mismatching audio codec is refused rather than converted.
  if (!audioOk && i.mode === 'original') issues.push('audio-codec-container');
  if (issues.length) return base;
  const transcodeAudio = !audioOk && (i.hasMuxedAudio || i.separateAudio || !i.isHls);

  const sameContainerAsSource = !i.isHls && i.sourceFormat === target && !mergeNeeded;
  if (sameContainerAsSource) {
    return finalize({ ...base, pipeline: 'native', video: 'copy', audio: 'copy', extension: target }, i);
  }
  const concatOnly = i.isHls && !mergeNeeded && !transcodeAudio && target === 'ts' && !i.fragmented;
  if (concatOnly) {
    return finalize(
      {
        ...base,
        pipeline: 'hls-concat',
        video: 'copy',
        audio: i.hasMuxedAudio ? 'copy' : 'none',
        extension: 'ts',
      },
      i,
    );
  }
  return finalize(
    {
      ...base,
      requiresFfmpeg: true,
      pipeline: transcodeAudio ? 'ffmpeg-transcode' : i.isHls ? 'hls-ffmpeg-copy' : 'file-ffmpeg-copy',
      video: 'copy',
      audio:
        i.hasMuxedAudio || i.separateAudio || !i.isHls ? (transcodeAudio ? 'transcode' : 'copy') : 'none',
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
