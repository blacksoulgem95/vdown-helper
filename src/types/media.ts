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
  | 'opus'
  | 'aiff'
  | 'wma'
  | 'flv'
  | 'avi'
  | 'wmv'
  | 'asf'
  | '3gp'
  | 'mpg'
  | 'hls'
  | 'm3u'
  | 'dash'
  | 'vtt'
  | 'srt'
  | 'ttml'
  | 'blob'
  | 'unknown';

export type StreamKind =
  | 'file'
  | 'hls-master'
  | 'hls-media'
  | 'dash'
  | 'unsupported-playlist'
  | 'blob'
  /** A subtitle/caption document or stream (format: vtt/srt/ttml, or hls/dash for segmented ones). */
  | 'subtitle';

export type DetectionMethod =
  | 'dom-element'
  | 'dom-source'
  | 'dom-link'
  | 'dom-track'
  | 'performance'
  | 'network'
  | 'hook'
  | 'manual-rescan';

/** Machine-readable reason, mapped to a localised string by the UI. */
export type ReasonCode =
  | 'ok'
  | 'not-probed'
  | 'blob-source'
  | 'drm'
  | 'sample-aes'
  | 'eme'
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
  | 'no-segments'
  | 'dash-clearkey'
  | 'subtitle-unsupported'
  | 'too-large';

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
  /** DASH: number of periods in the manifest (only the longest, the main content, is downloaded). */
  periods?: number;
}

/**
 * Bytes that only the page holds: a `data:` URL (later also a `blob:` URL). The extension never fetches these; the
 * content script of the owning frame reads them and hands them over (src/content/ingest.ts), so the resource carries
 * a small handle instead of the data.
 */
export interface PageHeld {
  kind: 'data';
  /** Handle inside the owning frame's scanner (a hash of the data), not a URL. */
  id: string;
  /** Decoded size in bytes. */
  bytes: number;
  /** Frame that holds it; set by the background from its own scan. */
  frameId?: number;
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
  /** Subtitle renditions the manifest lists (HLS SUBTITLES, DASH text); offered as their own subtitle resources. */
  subtitleTracks?: HlsRendition[];
  /** Subtitle language (BCP 47) when the page or manifest states it. */
  language?: string;
  playlist?: PlaylistSummary;
  /** Poster/thumbnail URL when the page provides one. */
  poster?: string;
  /** Frame the resource was found in (0 = top frame) and that frame's document URL. */
  frameId?: number;
  frameUrl?: string;
  /** Set when the bytes live in the page (data: URL): `url` is then only a label, never fetched. */
  held?: PageHeld;
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
  /** Bytes held by the page (a data: URL); `url` is then a harmless label. */
  held?: PageHeld;
  /** `<track>` elements: a subtitle, with its declared language and label. */
  role?: 'subtitle';
  language?: string;
  label?: string;
  /** Set by the background from the frame that reported the candidate (never trusted from the page). */
  frameId?: number;
  frameUrl?: string;
}

/** Things a scan could see but not use. */
export interface ScanNotes {
  blobSources: number;
  inaccessibleFrames: number;
  /** Origins of embedded frames that could not be read (the user can grant access to them). */
  blockedFrameOrigins: string[];
}

/** What one frame's scanner reports. `pageUrl`/`pageTitle` describe that frame's own document. */
export interface ScanReport {
  pageUrl: string;
  pageTitle: string;
  candidates: RawCandidate[];
  notes: ScanNotes;
  /** Added by the background from the injection result. */
  frameId?: number;
}
