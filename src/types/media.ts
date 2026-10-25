import type { HlsRendition, HlsVariant, KeyMethod, PlaylistClass } from './hls';

export type MediaFormat =
  | 'mp4'
  | 'webm'
  | 'mkv'
  | 'mov'
  | 'ogv'
  | 'ts'
  | 'mp3'
  | 'm4a'
  | 'aac'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'hls'
  | 'm3u'
  | 'dash'
  | 'blob'
  | 'unknown';

export type StreamKind = 'file' | 'hls-master' | 'hls-media' | 'unsupported-playlist' | 'blob';

export type DetectionMethod =
  | 'dom-element'
  | 'dom-source'
  | 'dom-link'
  | 'performance'
  | 'network'
  | 'manual-rescan';

/** Machine-readable reason, mapped to a localised string by the UI. */
export type ReasonCode =
  | 'ok'
  | 'not-probed'
  | 'blob-source'
  | 'drm'
  | 'sample-aes'
  | 'cors'
  | 'http-error'
  | 'network'
  | 'dash'
  | 'plain-m3u'
  | 'malformed'
  | 'live'
  | 'unsafe-url'
  | 'unsupported-format'
  | 'aes-key-inaccessible'
  | 'no-segments';

export type DownloadabilityStatus = 'downloadable' | 'protected' | 'inaccessible' | 'unsupported' | 'unknown';

export interface Downloadability {
  status: DownloadabilityStatus;
  reason: ReasonCode;
  /** Short, non-sensitive detail for the technical-details view (never contains URLs with tokens). */
  detail?: string;
}

export interface PlaylistSummary {
  playlistClass: PlaylistClass;
  segmentCount?: number;
  targetDuration?: number;
  live?: boolean;
  encryption: KeyMethod[];
  fragmented?: boolean;
}

export interface MediaResource {
  /** Stable id derived from the normalised URL. */
  id: string;
  url: string;
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  host: string;
  title: string;
  kind: StreamKind;
  format: MediaFormat;
  mediaType: 'video' | 'audio' | 'unknown';
  mimeType?: string;
  sizeBytes?: number;
  sizeIsEstimate?: boolean;
  durationSec?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  frameRate?: number;
  codecs?: string;
  detectedBy: DetectionMethod[];
  downloadability: Downloadability;
  variants: HlsVariant[];
  audioTracks: HlsRendition[];
  playlist?: PlaylistSummary;
  /** Poster/thumbnail URL when the page provides one. */
  poster?: string;
  detectedAt: number;
}

/** Raw candidate reported by the content script before probing. */
export interface RawCandidate {
  url: string;
  method: DetectionMethod;
  title?: string;
  mimeType?: string;
  mediaType?: 'video' | 'audio';
  durationSec?: number;
  width?: number;
  height?: number;
  poster?: string;
}

export interface ScanReport {
  pageUrl: string;
  pageTitle: string;
  candidates: RawCandidate[];
  /** Counts of things the scanner could see but not use (e.g. blob: sources, cross-origin frames). */
  notes: { blobSources: number; inaccessibleFrames: number };
}
