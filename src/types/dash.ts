/** Types produced by the DASH (MPEG-DASH, ISO/IEC 23009-1) parser in src/lib/dash. */

export type DashContent = 'video' | 'audio' | 'text' | 'other';

export type DashProtectionSystem =
  | 'widevine'
  | 'playready'
  | 'fairplay'
  | 'marlin'
  | 'clearkey'
  /** `urn:mpeg:dash:mp4protection:2011`: says the media is CENC-encrypted without naming a key system. */
  | 'cenc'
  | 'other';

export interface DashProtection {
  system: DashProtectionSystem;
  schemeIdUri: string;
  /** ClearKey licence URL (`Laurl`), when the manifest gives one. */
  licenseUrl?: string;
  defaultKid?: string;
}

export interface DashByteRange {
  offset: number;
  length: number;
}

export interface DashSegmentRef {
  url: string;
  range?: DashByteRange;
}

export type DashAddressing =
  | {
      kind: 'template';
      initialization?: string;
      media: string;
      startNumber: number;
      timescale: number;
      /** Constant segment duration in timescale units (no timeline). */
      duration?: number;
      timeline?: Array<{ t?: number; d: number; r: number }>;
      presentationTimeOffset: number;
    }
  | {
      kind: 'list';
      initialization?: DashSegmentRef;
      segments: Array<DashSegmentRef & { durationSec?: number }>;
      timescale: number;
    }
  /** One whole file (BaseURL only, or SegmentBase with an index): downloaded as a single resource. */
  | { kind: 'single'; url: string };

export interface DashRepresentation {
  id: string;
  content: DashContent;
  mimeType: string;
  codecs?: string;
  bandwidth: number;
  width?: number;
  height?: number;
  frameRate?: number;
  lang?: string;
  label?: string;
  protections: DashProtection[];
  /** Absolute base URL the segment URLs are relative to. */
  baseUrl: string;
  addressing: DashAddressing;
}

export interface DashPeriod {
  id?: string;
  startSec: number;
  durationSec?: number;
  representations: DashRepresentation[];
}

export interface DashManifest {
  url: string;
  type: 'static' | 'dynamic';
  durationSec?: number;
  /** `availabilityStartTime` of a dynamic manifest, in ms since the epoch. */
  availabilityStartMs?: number;
  /** `minimumUpdatePeriod`: how often a dynamic manifest asks to be fetched again. */
  minimumUpdateSec?: number;
  /** `timeShiftBufferDepth`: how far back a dynamic manifest keeps segments. */
  timeShiftBufferSec?: number;
  periods: DashPeriod[];
}

export type DashErrorCode = 'malformed' | 'not-dash' | 'unsafe-url' | 'empty';

export type DashParseResult =
  { ok: true; manifest: DashManifest } | { ok: false; error: { code: DashErrorCode; message: string } };
