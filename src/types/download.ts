import type { MediaFormat, PageHeld } from './media';

export type OutputMode = 'video-audio' | 'audio-only' | 'video-only' | 'original';
export type AudioFormat = 'mp3' | 'm4a' | 'aac' | 'wav';
export type VideoContainer = 'mp4' | 'mkv' | 'ts' | 'original';
export type AudioBitrate = 128 | 192 | 256 | 320;

export type JobStage =
  'detected' | 'preparing' | 'downloading' | 'merging' | 'encoding' | 'completed' | 'failed' | 'cancelled';

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
  /** Show Chrome's "Save as" dialog for this download. */
  saveAs?: boolean;
  /**
   * Origins the user granted access to. Only these are fetched with cookies; every other origin is fetched
   * without credentials, which is what wildcard-CORS CDNs require.
   */
  credentialedOrigins?: string[];
  /**
   * Set by the background (never trusted from the UI) from its own scan: the frame that owns the stream and the URLs
   * involved, so the frame's Referer/Origin can be replayed on this job's requests.
   */
  replay?: { frameUrl: string; urls: string[] };
  /**
   * A subtitle download. The source is a text document, or (isHls / isDash) a segmented subtitle stream that is
   * stitched. `output`: keep the format found (WebVTT for stitched streams) or convert to SRT.
   */
  subtitle?: { output: 'srt' | 'original' };
  /**
   * The bytes are held by the page (data: URL). Set by the background from its own scan, never trusted from the UI;
   * `sourceUrl` is then only a label and is never fetched.
   */
  held?: PageHeld;
  /**
   * Several plain files packed into one ZIP. The UI names the resources; the background re-derives every URL and
   * entry name from its own scan (`items`), so a request can never make the extension fetch a URL it has not seen.
   */
  zip?: {
    resourceIds: string[];
    items?: Array<{ url: string; name: string; deflate: boolean }>;
    /** Selected files that could not be included (page-held, not downloadable, over the item limit). */
    left?: number;
  };
  /** A plain file (image, document, archive, page asset) saved as it is. */
  file?: { kind: 'image' | 'document' | 'archive' | 'asset' };
  /** Source description for the queue display. */
  qualityLabel: string;
  sourceFormat: MediaFormat;
  /** True when the source is HLS (needs the segment pipeline). */
  isHls: boolean;
  /** True when the source is an MPEG-DASH manifest; the representation is named in the URL fragment (lib/dash/ref). */
  isDash?: boolean;
  /** HLS segments are fMP4 (init section) rather than MPEG-TS. */
  fragmented?: boolean;
  /** The chosen stream already carries audio. */
  hasMuxedAudio: boolean;
  /** The source has a video track at all. */
  hasVideo: boolean;
  /** Live/event stream: refused. */
  live?: boolean;
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
  /** True when the segment/FFmpeg pipeline in the offscreen document performs this job. */
  viaOffscreen?: boolean;
  /** A native download was refused (401/403) and this job was handed to the extension's own fetch pipeline. */
  staged?: boolean;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Final path reported by Chrome once completed. */
  filePath?: string;
  /** Files the job could not include (a ZIP lists them inside the archive). */
  skipped?: number;
  /** Number of times the user retried. */
  attempts: number;
}
