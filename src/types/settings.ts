import type { AudioBitrate, AudioFormat, OutputMode } from './download';

export type QualityPreset = 'highest' | '2160' | '1440' | '1080' | '720' | '480' | '360';

export interface Settings {
  schemaVersion: 1;
  defaultMode: OutputMode;
  /**
   * Container of a one-click video download. 'mp4' re-packages the stream (never re-encodes it) so the file plays
   * everywhere; when MP4 cannot hold the codecs or the stream is too large to re-package in memory, the original is kept.
   */
  defaultContainer: 'mp4' | 'original';
  preferredQuality: QualityPreset;
  defaultAudioFormat: AudioFormat;
  defaultAudioBitrate: AudioBitrate;
  /** Template with tokens: {title} {host} {resolution} {date} {format} {id}. */
  namingTemplate: string;
  /** Relative sub-folder inside the Chrome Downloads folder; empty = none. */
  subfolder: string;
  /** Show Chrome's "Save as" dialog for every download. */
  askWhereToSave: boolean;
  /** Scan automatically when a tab finishes loading (needs the optional host permission). */
  autoScan: boolean;
  /** Run the read-only page hook in every frame of granted sites (needs site access). */
  pageHook: boolean;
  /** Observe media requests via webRequest (needs the optional permission). */
  networkObserver: boolean;
  /** Images smaller than this (shorter side, in pixels) are hidden in the Images tab; 0 = show all. */
  imageMinPx: number;
  maxConcurrentDownloads: number;
  /** Parallel segment fetches per HLS job. */
  segmentConcurrency: number;
  /** Largest output allowed to be assembled in browser memory, in MB. */
  maxMemoryMb: number;
  /** Refuse FFmpeg conversions longer than this (seconds of media), 0 = no limit. */
  maxEncodeDurationSec: number;
  /** Container of a recorded MediaStream when this Chrome can record it natively; otherwise WebM. */
  recordContainer: 'webm' | 'mp4';
  /** A recording (MediaStream, live stream) stops by itself after this many minutes. */
  recordMaxMinutes: number;
  /** ... or after this many MB have been recorded. */
  recordMaxMb: number;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
}
