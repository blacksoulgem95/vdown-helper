import type { MediaFormat } from './media';

export type OutputMode = 'video-audio' | 'audio-only' | 'video-only' | 'original';
export type AudioFormat = 'mp3' | 'm4a' | 'aac' | 'wav';
export type VideoContainer = 'mp4' | 'mkv' | 'ts' | 'original';
export type AudioBitrate = 128 | 192 | 256 | 320;

export type JobStage =
  | 'detected'
  | 'preparing'
  | 'downloading'
  | 'merging'
  | 'encoding'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobErrorCode =
  | 'cors'
  | 'http-error'
  | 'network'
  | 'protected'
  | 'too-large'
  | 'out-of-memory'
  | 'ffmpeg'
  | 'decrypt'
  | 'chrome-download'
  | 'interrupted'
  | 'invalid'
  | 'unknown';

export interface JobError {
  code: JobErrorCode;
  message: string;
}

/** What the user asked for. Validated by lib/compat before a job can start. */
export interface DownloadRequest {
  resourceId: string;
  /** Absolute URL of the chosen media (direct file, or variant playlist). */
  sourceUrl: string;
  /** Absolute URL of the chosen separate audio rendition, when merging. */
  audioUrl?: string;
  /** Master playlist URL, kept for display. */
  masterUrl?: string;
  tabId: number;
  pageUrl: string;
  host: string;
  mode: OutputMode;
  container: VideoContainer;
  audioFormat: AudioFormat;
  audioBitrate: AudioBitrate;
  /** Final filename without directory, sanitised, with extension. */
  filename: string;
  subfolder: string;
  /** Source description for the queue display. */
  qualityLabel: string;
  sourceFormat: MediaFormat;
  /** True when the source is HLS (needs the segment pipeline). */
  isHls: boolean;
  /** Source codecs when known; used for copy-vs-transcode decisions. */
  videoCodec?: string;
  audioCodec?: string;
  /** Known total duration in seconds. */
  durationSec?: number;
  /** Estimated output size in bytes, when it can be calculated. */
  estimatedBytes?: number;
}

export interface JobProgress {
  /** 0..1, undefined when not measurable. */
  fraction?: number;
  bytesDone?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  /** Human-readable step counters such as segments. */
  unitsDone?: number;
  unitsTotal?: number;
}

export interface DownloadJob {
  id: string;
  request: DownloadRequest;
  stage: JobStage;
  progress: JobProgress;
  error?: JobError;
  /** chrome.downloads id of the final file once handed to Chrome. */
  chromeDownloadId?: number;
  /** Which stages this job actually passes through (never simulated). */
  stages: JobStage[];
  /** True when the underlying mechanism supports pause/resume (direct downloads only). */
  canPause: boolean;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Final path reported by Chrome once completed. */
  filePath?: string;
  /** Number of times the user retried. */
  attempts: number;
}
