import type { DesktopStatus } from './desktop';
import type { DownloadJob, DownloadRequest, JobProgress, JobStage } from './download';
import type { MediaResource, ScanNotes } from './media';
import type { HlsKey } from './hls';

/** Failure envelope returned by every handler. Messages are safe to show: they never contain URLs with tokens. */
export interface Failure {
  ok: false;
  error: string;
}
export type Result<T> = ({ ok: true } & T) | Failure;

/** Per-tab scan state shared between background and UI through chrome.storage.session. */
export interface TabState {
  tabId: number;
  status: 'idle' | 'scanning' | 'ready' | 'error';
  pageUrl: string;
  pageTitle: string;
  scannedAt?: number;
  resources: MediaResource[];
  /** Things the scanner saw but cannot use. */
  notes: ScanNotes;
  error?: string;
  /** True when the optional network observer is active for this tab. */
  observing: boolean;
}

export interface VariantInspection {
  url: string;
  segmentCount: number;
  durationSec: number;
  targetDuration?: number;
  live: boolean;
  fragmented: boolean;
  encryption: string[];
  protectedByDrm: boolean;
  /** Keys that must be fetched to decrypt (AES-128 only). */
  keyUris: string[];
  /** Origins that will be contacted for this job (playlist, segments, keys), used for access checks. */
  origins: string[];
  /** One representative URL per origin, used to test whether the extension can already reach it. */
  originSamples: Record<string, string>;
  firstSegmentExt: string;
}

/** UI/background request protocol. Each key maps request payload -> response. */
export interface RequestMap {
  scan: { req: { tabId: number }; res: Result<{ state: TabState }> };
  /** A link the user pasted (an .m3u8/.mpd or a media file): remembered for the tab, then the tab is scanned again. */
  'add-url': { req: { tabId: number; url: string }; res: Result<{ state: TabState }> };
  'get-state': { req: { tabId: number }; res: Result<{ state: TabState | null }> };
  'inspect-variant': {
    req: { tabId: number; url: string; frameId?: number };
    res: Result<{ inspection: VariantInspection }>;
  };
  /** `desktop`: the user pressed "Send to desktop app" (honoured only while the desktop app is on). */
  'start-download': {
    req: { request: DownloadRequest; desktop?: boolean };
    res: Result<{ jobId: string }>;
  };
  'job-action': {
    req: { jobId: string; action: 'cancel' | 'retry' | 'pause' | 'resume' | 'remove' | 'stop' };
    res: Result<object>;
  };
  'clear-history': { req: Record<string, never>; res: Result<object> };
  'get-jobs': { req: Record<string, never>; res: Result<{ jobs: DownloadJob[] }> };
  'set-observer': { req: { enabled: boolean }; res: Result<object> };
  /** Bring the page hook's registration up to date now (after a grant), so a reload that follows finds it in place. */
  'sync-hook': { req: Record<string, never>; res: Result<{ registered: boolean }> };
  /** Whether the desktop app is on and answers (the options page). */
  'desktop-status': { req: Record<string, never>; res: Result<{ status: DesktopStatus }> };
}

export type RequestType = keyof RequestMap;

export interface Envelope<K extends RequestType = RequestType> {
  channel: 'vdown';
  type: K;
  payload: RequestMap[K]['req'];
}

/** Background -> offscreen document commands. */
export type OffscreenCommand =
  | {
      channel: 'vdown-offscreen';
      type: 'run-job';
      jobId: string;
      request: DownloadRequest;
      plan: OffscreenPlan;
    }
  | { channel: 'vdown-offscreen'; type: 'cancel-job'; jobId: string }
  /** Finish a live recording and save what it has. */
  | { channel: 'vdown-offscreen'; type: 'stop-job'; jobId: string }
  | { channel: 'vdown-offscreen'; type: 'release-job'; jobId: string };

export interface OffscreenPlan {
  pipeline:
    | 'hls-concat'
    | 'hls-ffmpeg-copy'
    | 'ffmpeg-transcode'
    | 'file-ffmpeg-copy'
    | 'file-staged'
    | 'subtitle'
    | 'zip'
    | 'capture'
    | 'record'
    | 'live';
  extension: string;
  requiresFfmpeg: boolean;
  video: 'copy' | 'transcode' | 'none';
  audio: 'copy' | 'transcode' | 'none';
  maxMemoryMb: number;
  segmentConcurrency: number;
  /** Largest recording (MB) a MediaStream or live recording may reach. */
  recordMaxMb?: number;
  recordMaxMinutes?: number;
}

/** Offscreen document -> background events. */
export type OffscreenEvent =
  | { channel: 'vdown-offscreen-event'; type: 'stage'; jobId: string; stage: JobStage }
  | { channel: 'vdown-offscreen-event'; type: 'progress'; jobId: string; progress: JobProgress }
  | {
      channel: 'vdown-offscreen-event';
      type: 'ready';
      jobId: string;
      blobUrl: string;
      bytes: number;
      /** Files left out of the result (a ZIP). */
      skipped?: number;
      /** A live recording: segments that were gone when they were due. */
      gaps?: number;
      /** Extension of the produced file when the pipeline decides it late (a capture). */
      extension?: string;
      /** The conversion could not be done in browser memory: the stream is saved as it was downloaded. */
      keptOriginal?: boolean;
      /** A capture split into parts at a quality switch: the other parts, each its own download. */
      extraParts?: Array<{ jobId: string; blobUrl: string; bytes: number; extension: string }>;
    }
  | { channel: 'vdown-offscreen-event'; type: 'failed'; jobId: string; code: string; message: string }
  | { channel: 'vdown-offscreen-event'; type: 'cancelled'; jobId: string };

export type { HlsKey };
