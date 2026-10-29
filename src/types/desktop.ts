import type { JobErrorCode, JobProgress, JobStage } from './download';

/**
 * Which downloads go to the desktop app when it is on: none, every HLS/DASH stream and every conversion (the default),
 * or everything it can take. Page-held media (captures, recordings, blobs) and ZIPs always stay in the browser.
 */
export type DesktopRouting = 'never' | 'streams' | 'always';

export interface DesktopSettings {
  /** The user turned the desktop app on (and granted the native messaging permission). */
  enabled: boolean;
  routing: DesktopRouting;
}

/** Where a job handed to the app is, as the app reports it (`gone`: the app does not know it). */
export interface AppJobStatus {
  jobId: string;
  stage: JobStage | 'gone';
  paused?: boolean;
  progress?: JobProgress;
  stages?: JobStage[];
  path?: string;
  bytes?: number;
  error?: { code: JobErrorCode; message: string };
}

/** Protocol v1, app -> extension (docs/desktop.md). */
export type AppMessage =
  | { type: 'hello'; appVersion: string; ffmpeg: string | null }
  | { type: 'accepted'; jobId: string; stages: JobStage[] }
  | { type: 'stage'; jobId: string; stage: JobStage }
  | { type: 'progress'; jobId: string; progress: JobProgress }
  | { type: 'done'; jobId: string; path: string; bytes?: number }
  | { type: 'error'; jobId?: string; code: JobErrorCode; message: string }
  | { type: 'cancelled'; jobId: string }
  | { type: 'needs-cookies'; jobId: string; origins: string[] }
  | { type: 'status'; jobs: AppJobStatus[] };

/** What the options page shows about the app. */
export interface DesktopStatus {
  enabled: boolean;
  connected: boolean;
  appVersion?: string;
  ffmpeg?: string | null;
  error?: string;
}
