/**
 * Requests: the user's choices for a resource, the request they become, the plan for it, and the validation of a
 * request received over messaging. Implemented in Rust (`core/src/request.rs`), shared with the desktop app.
 */
import type {
  AudioBitrate,
  AudioFormat,
  DownloadRequest,
  OutputMode,
  VideoContainer,
} from '@/types/download';
import type { HlsRendition, HlsVariant } from '@/types/hls';
import type { VariantInspection } from '@/types/messages';
import type { MediaResource } from '@/types/media';
import type { Settings } from '@/types/settings';
import type { Plan } from './compat';
import { core } from './core';

export interface Choices {
  mode: OutputMode;
  container: VideoContainer;
  audioFormat: AudioFormat;
  audioBitrate: AudioBitrate;
  /** Index into resource.variants (HLS master). */
  variantIndex: number;
  /** Index into the audio renditions compatible with the chosen variant; -1 = none/muxed. */
  audioIndex: number;
  /** Subtitles: keep the format found, or convert to SRT. */
  subtitleOutput: 'srt' | 'original';
  /** User-typed base name (no extension); empty = use the naming template. */
  filename: string;
  /** Override of the global "ask where to save" setting. */
  saveAs?: boolean;
}

/** The `{date}` of a file name: the core has no clock. */
const today = (): string => new Date().toISOString().slice(0, 10);

/** Audio renditions that belong to the chosen variant's audio group (or all, for audio-only masters). */
export function audioOptions(resource: MediaResource, variant: HlsVariant | undefined): HlsRendition[] {
  return core.audioOptions(resource, variant) as HlsRendition[];
}

export function defaultChoices(resource: MediaResource, settings: Settings): Choices {
  return core.defaultChoices(resource, settings) as Choices;
}

/**
 * The choices, or the same with the original container when the preferred one cannot work for this stream: MP4 cannot
 * hold its codecs, or the stream is too large or too long to re-package in browser memory. A one-click download then still
 * saves the stream (as TS) instead of failing.
 */
export function workableChoices(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
  inspection?: VariantInspection,
): Choices {
  return core.workableChoices(resource, settings, choices, inspection, today()) as Choices;
}

/** Keep the original unless the format is not one we can name (then a converted SRT is the only honest result). */
export function defaultSubtitleOutput(resource: MediaResource): 'srt' | 'original' {
  return core.defaultSubtitleOutput(resource) as 'srt' | 'original';
}

/**
 * A ZIP of several plain files. The request only names the resources; the background derives the URLs and entry names
 * from its own scan. The size estimate is the sum of the sizes the page or server stated.
 */
export function buildZipRequest(resources: readonly MediaResource[], settings: Settings): DownloadRequest {
  return core.buildZipRequest([...resources], settings) as DownloadRequest;
}

/** Assemble a request from a resource and the user's choices. */
export function buildRequest(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
  inspection?: VariantInspection,
): DownloadRequest {
  return core.buildRequest(resource, settings, choices, inspection, today()) as DownloadRequest;
}

export function qualityLabelFor(
  req: Pick<DownloadRequest, 'mode' | 'audioFormat' | 'audioBitrate' | 'sourceFormat'>,
  height: number | undefined,
): string {
  return core.qualityLabelFor(req.mode, req.audioFormat, req.sourceFormat, height);
}

/** Single source of truth for "what will happen and is it allowed", used by both the UI and the background. */
export function planFromRequest(
  req: DownloadRequest,
  limits: { maxMemoryMb: number; maxEncodeDurationSec: number },
): Plan {
  return core.planFromRequest(req, limits) as Plan;
}

/** A recording request for a live stream the scan found, with the quality the user's settings prefer. */
export function buildLiveRequest(resource: MediaResource, settings: Settings): DownloadRequest {
  return core.buildLiveRequest(resource, settings, today()) as DownloadRequest;
}

/** A recording request for a MediaStream the scan found (`held.kind === 'stream'`). */
export function buildRecordRequest(resource: MediaResource, settings: Settings): DownloadRequest {
  return core.buildRecordRequest(resource, settings, today()) as DownloadRequest;
}

/** A capture request for a MediaSource player the scan found (`held.kind === 'mse'`). */
export function buildCaptureRequest(
  resource: MediaResource,
  settings: Settings,
  speed: 'fast' | 'realtime',
): DownloadRequest {
  return core.buildCaptureRequest(resource, settings, speed, today()) as DownloadRequest;
}

/** ZIP archives are classic ZIP (not ZIP64): never above 4 GB, and never above the user's memory/size limit. */
export const MAX_ZIP_BYTES = 4000 * 1024 * 1024;

export function zipLimitBytes(maxMemoryMb: number): number {
  return core.zipLimitBytes(maxMemoryMb);
}

/**
 * Normalise a request received over messaging: never trust the sender's filename, folder or URLs.
 * Returns undefined when a URL is unsafe.
 */
export function sanitizeRequest(req: DownloadRequest): DownloadRequest | undefined {
  return core.sanitizeRequest(req) as DownloadRequest | undefined;
}
