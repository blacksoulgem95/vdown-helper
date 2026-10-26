import type {
  AudioBitrate,
  AudioFormat,
  DownloadRequest,
  OutputMode,
  VideoContainer,
} from '@/types/download';
import type { HlsRendition, HlsVariant } from '@/types/hls';
import type { VariantInspection } from '@/types/messages';
import type { MediaFormat, MediaResource } from '@/types/media';
import type { Settings } from '@/types/settings';
import { planOutput, type Plan, type PlanInput } from './compat';
import {
  describeCodecs,
  estimateBytes,
  formatFromMime,
  resolutionLabel,
  SUBTITLE_FILE_FORMATS,
  type AudioFamily,
  type VideoFamily,
} from './media';
import { isDataLabel } from './dataUrl';
import { isFileKind, type FileKind } from './filetypes';
import { MAX_ZIP_ITEMS } from './zip';
import { pickVariantIndex } from './settings';
import {
  isSafeFetchUrl,
  renderNameTemplate,
  sanitizeFilename,
  sanitizeSubfolder,
  withExtension,
  parseUrl,
} from './security';

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

/** Audio renditions that belong to the chosen variant's audio group (or all, for audio-only masters). */
export function audioOptions(resource: MediaResource, variant: HlsVariant | undefined): HlsRendition[] {
  if (!variant) return resource.audioTracks;
  if (!variant.audioGroup) return [];
  return resource.audioTracks.filter((a) => a.groupId === variant.audioGroup);
}

export function defaultChoices(resource: MediaResource, settings: Settings): Choices {
  const variantIndex = pickVariantIndex(
    resource.variants.map((v) => v.height),
    settings.preferredQuality,
  );
  const variant = resource.variants[variantIndex];
  const opts = audioOptions(resource, variant);
  const def = opts.findIndex((a) => a.isDefault);
  let mode = settings.defaultMode;
  if (resource.mediaType === 'audio' && (mode === 'video-audio' || mode === 'video-only')) mode = 'original';
  return {
    mode,
    container: 'original',
    audioFormat: settings.defaultAudioFormat,
    audioBitrate: settings.defaultAudioBitrate,
    variantIndex: Math.max(variantIndex, 0),
    audioIndex: opts.length ? Math.max(def, 0) : -1,
    subtitleOutput: defaultSubtitleOutput(resource),
    filename: '',
  };
}

/** Keep the original unless the format is not one we can name (then a converted SRT is the only honest result). */
export function defaultSubtitleOutput(resource: MediaResource): 'srt' | 'original' {
  return resource.kind === 'subtitle' && !isKnownSubtitleFormat(resource.format) ? 'srt' : 'original';
}

function isKnownSubtitleFormat(format: MediaFormat): boolean {
  return SUBTITLE_FILE_FORMATS.has(format) || format === 'hls' || format === 'dash';
}

/** The extension of the file a subtitle request produces. */
function subtitleExtension(format: MediaFormat, output: 'srt' | 'original'): string {
  if (output === 'srt') return 'srt';
  return SUBTITLE_FILE_FORMATS.has(format) ? format : 'vtt'; // stitched streams are written as WebVTT
}

/**
 * A ZIP of several plain files. The request only names the resources; the background derives the URLs and entry names
 * from its own scan. The size estimate is the sum of the sizes the page or server stated (unknown sizes count as 0:
 * the packer enforces the limit again while it runs).
 */
export function buildZipRequest(resources: readonly MediaResource[], settings: Settings): DownloadRequest {
  const first = resources[0] as MediaResource;
  const known = resources.reduce((n, r) => n + (r.held ? 0 : (r.sizeBytes ?? 0)), 0);
  const title = sanitizeFilename(first.pageTitle || first.host, 'files', 100);
  const req: DownloadRequest = {
    resourceId: first.id,
    // Only a label for the queue and a safe URL for validation: the files come from `zip.items`.
    sourceUrl: first.pageUrl,
    tabId: first.tabId,
    pageUrl: first.pageUrl,
    host: first.host,
    mode: 'original',
    container: 'original',
    audioFormat: settings.defaultAudioFormat,
    audioBitrate: settings.defaultAudioBitrate,
    filename: withExtension(`${title} (${resources.length} files)`, 'zip'),
    subfolder: sanitizeSubfolder(settings.subfolder),
    saveAs: settings.askWhereToSave,
    qualityLabel: `ZIP · ${resources.length}`,
    sourceFormat: 'unknown',
    isHls: false,
    hasMuxedAudio: false,
    hasVideo: false,
    zip: { resourceIds: resources.slice(0, MAX_ZIP_ITEMS).map((r) => r.id) },
  };
  if (known > 0) req.estimatedBytes = known;
  return req;
}

/** Images, documents, archives and page assets: saved as they are, under the name the server gives them. */
function buildPlainFileRequest(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
  kind: FileKind,
): DownloadRequest {
  const ext = resource.ext ?? '';
  const base = sanitizeFilename(choices.filename.trim() || resource.title, 'file');
  const req: DownloadRequest = {
    resourceId: resource.id,
    sourceUrl: resource.url,
    tabId: resource.tabId,
    pageUrl: resource.pageUrl,
    host: resource.host,
    mode: 'original',
    container: 'original',
    audioFormat: choices.audioFormat,
    audioBitrate: choices.audioBitrate,
    filename: ext ? withExtension(base, ext) : base,
    subfolder: sanitizeSubfolder(settings.subfolder),
    saveAs: choices.saveAs ?? settings.askWhereToSave,
    qualityLabel: ext.toUpperCase(),
    sourceFormat: 'unknown',
    isHls: false,
    hasMuxedAudio: false,
    hasVideo: false,
    file: { kind },
  };
  if (resource.held) req.held = resource.held;
  if (resource.sizeBytes !== undefined) req.estimatedBytes = resource.sizeBytes;
  return req;
}

function buildSubtitleRequest(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
): DownloadRequest {
  const output = isKnownSubtitleFormat(resource.format) ? choices.subtitleOutput : 'srt';
  const isHls = resource.format === 'hls';
  const isDash = resource.format === 'dash';
  const ext = subtitleExtension(resource.format, output);
  const lang = resource.language ? sanitizeFilename(resource.language) : '';
  const base = choices.filename.trim()
    ? sanitizeFilename(choices.filename)
    : renderNameTemplate(settings.namingTemplate, {
        title:
          lang && !resource.title.toLowerCase().includes(lang.toLowerCase())
            ? `${resource.title}.${lang}`
            : resource.title,
        host: resource.host,
        resolution: '',
        date: new Date().toISOString().slice(0, 10),
        format: ext,
        id: resource.id,
      });
  const req: DownloadRequest = {
    resourceId: resource.id,
    sourceUrl: resource.url,
    tabId: resource.tabId,
    pageUrl: resource.pageUrl,
    host: resource.host,
    mode: 'original',
    container: 'original',
    audioFormat: choices.audioFormat,
    audioBitrate: choices.audioBitrate,
    filename: withExtension(base, ext),
    subfolder: sanitizeSubfolder(settings.subfolder),
    saveAs: choices.saveAs ?? settings.askWhereToSave,
    qualityLabel: output === 'srt' ? 'SRT' : ext.toUpperCase(),
    sourceFormat: resource.format,
    isHls,
    hasMuxedAudio: false,
    hasVideo: false,
    subtitle: { output },
  };
  if (isDash) req.isDash = true;
  if (resource.durationSec) req.durationSec = resource.durationSec;
  return req;
}

function familyOf(codecs: string | undefined): { video?: VideoFamily; audio?: AudioFamily } {
  const c = describeCodecs(codecs);
  return { ...(c.video ? { video: c.video.family } : {}), ...(c.audio ? { audio: c.audio.family } : {}) };
}

/** Assemble a request (without final filename) from a resource and the user's choices. */
export function buildRequest(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
  inspection?: VariantInspection,
): DownloadRequest {
  if (resource.kind === 'subtitle') return buildSubtitleRequest(resource, settings, choices);
  if (isFileKind(resource.kind)) return buildPlainFileRequest(resource, settings, choices, resource.kind);
  const isMaster = resource.kind === 'hls-master' || resource.kind === 'dash';
  const isDash = resource.kind === 'dash';
  const variant = isMaster ? resource.variants[choices.variantIndex] : undefined;
  const audioOpts = audioOptions(resource, variant);
  const audioTrack = choices.audioIndex >= 0 ? audioOpts[choices.audioIndex] : undefined;
  const audioOnlyMaster = isMaster && resource.variants.length === 0;
  const isHls = resource.kind === 'hls-master' || resource.kind === 'hls-media';

  let sourceUrl = resource.url;
  let audioUrl: string | undefined;
  let codecs = resource.codecs;
  let height = resource.height;
  let bandwidth = resource.bitrate;
  if (variant) {
    sourceUrl = variant.uri;
    codecs = variant.codecs;
    height = variant.height;
    bandwidth = variant.averageBandwidth ?? variant.bandwidth;
    if (audioTrack?.uri) audioUrl = audioTrack.uri;
  } else if (audioOnlyMaster) {
    sourceUrl = audioTrack?.uri ?? audioOpts[0]?.uri ?? resource.url;
  }
  if (choices.mode === 'audio-only' && isMaster) {
    if (audioUrl) {
      // Fetch only the audio rendition instead of the whole video.
      sourceUrl = audioUrl;
      audioUrl = undefined;
      // The track's own codec when the manifest states it (DASH); unknown (never assumed) otherwise.
      codecs = audioTrack ? audioTrack.codecs : codecs;
    } else if (variant) {
      // Audio is muxed into the video stream: use the lightest variant that carries audio.
      const lightest = [...resource.variants]
        .filter((v) => !v.audioGroup && (!v.codecs || describeCodecs(v.codecs).audio))
        .sort((a, b) => a.bandwidth - b.bandwidth)[0];
      if (lightest) {
        sourceUrl = lightest.uri;
        codecs = lightest.codecs;
        bandwidth = lightest.averageBandwidth ?? lightest.bandwidth;
      }
    }
  }
  if (choices.mode === 'video-only') audioUrl = undefined;
  const fam = familyOf(codecs);
  const separateAudio = audioUrl !== undefined;
  const hasVideo = !audioOnlyMaster && resource.mediaType !== 'audio';
  const audioCodecKnownMissing = codecs !== undefined && fam.audio === undefined && fam.video !== undefined;
  const audioFromRendition =
    choices.mode === 'audio-only' &&
    sourceUrl !== resource.url &&
    !!audioTrack?.uri &&
    sourceUrl === audioTrack.uri;
  const hasMuxedAudio =
    audioOnlyMaster || audioFromRendition ? true : separateAudio ? false : !audioCodecKnownMissing;

  const duration = inspection?.durationSec ?? resource.durationSec;
  const estimated = isHls || isDash ? estimateBytes(bandwidth, duration) : resource.sizeBytes;

  const req: DownloadRequest = {
    resourceId: resource.id,
    sourceUrl,
    tabId: resource.tabId,
    pageUrl: resource.pageUrl,
    host: resource.host,
    mode: choices.mode,
    container: choices.container,
    audioFormat: choices.audioFormat,
    audioBitrate: choices.audioBitrate,
    filename: '',
    subfolder: sanitizeSubfolder(settings.subfolder),
    saveAs: choices.saveAs ?? settings.askWhereToSave,
    qualityLabel: '',
    sourceFormat: isHls
      ? 'hls'
      : isDash
        ? 'dash'
        : resource.format !== 'unknown'
          ? resource.format
          : (formatFromMime(resource.mimeType) ?? 'unknown'),
    isHls,
    hasMuxedAudio,
    hasVideo,
  };
  if (audioUrl) req.audioUrl = audioUrl;
  if (resource.held) req.held = resource.held;
  if (isDash) req.isDash = true;
  if (isMaster && (isHls || isDash)) req.masterUrl = resource.url;
  if (isDash) req.fragmented = true; // DASH segments are fragmented MP4
  if (inspection) {
    req.fragmented = inspection.fragmented;
    req.live = inspection.live;
  } else if (resource.playlist) {
    if (resource.playlist.fragmented !== undefined) req.fragmented = resource.playlist.fragmented;
    if (resource.playlist.live !== undefined) req.live = resource.playlist.live;
  }
  if (fam.video) req.videoCodec = fam.video;
  // A separate audio track carries its own codec when the manifest says so.
  const trackAudio = separateAudio && audioTrack?.codecs ? familyOf(audioTrack.codecs).audio : undefined;
  if (fam.audio ?? trackAudio) req.audioCodec = (fam.audio ?? trackAudio) as string;
  if (duration) req.durationSec = duration;
  if (estimated !== undefined) req.estimatedBytes = estimated;

  const plan = planFromRequest(req, {
    maxMemoryMb: settings.maxMemoryMb,
    maxEncodeDurationSec: settings.maxEncodeDurationSec,
  });
  // May be empty for a source of unknown type: the file then keeps no extension and Chrome picks one.
  const ext = plan.extension;
  const base = choices.filename.trim()
    ? sanitizeFilename(choices.filename)
    : renderNameTemplate(settings.namingTemplate, {
        title: resource.title,
        host: resource.host,
        resolution: choices.mode === 'audio-only' ? '' : resolutionLabel(height),
        date: new Date().toISOString().slice(0, 10),
        format: ext,
        id: resource.id,
      });
  req.filename = ext ? withExtension(base, ext) : base;
  req.qualityLabel = qualityLabelFor(req, height);
  return req;
}

export function qualityLabelFor(
  req: Pick<DownloadRequest, 'mode' | 'audioFormat' | 'audioBitrate' | 'sourceFormat'>,
  height: number | undefined,
): string {
  if (req.mode === 'audio-only') return `${req.audioFormat.toUpperCase()}`;
  const res = resolutionLabel(height);
  return res || req.sourceFormat.toUpperCase();
}

/** Single source of truth for "what will happen and is it allowed", used by both the UI and the background. */
export function planFromRequest(
  req: DownloadRequest,
  limits: { maxMemoryMb: number; maxEncodeDurationSec: number },
): Plan {
  if (req.subtitle) return planSubtitle(req);
  if (req.file) return planPlainFile(req);
  if (req.zip) return planZipJob(req, limits);
  if (req.capture) return planCapture();
  const segmented = req.isHls || req.isDash === true;
  const input: PlanInput = {
    isHls: segmented, // the planner's "isHls" means: a segmented stream (HLS or DASH)
    sourceFormat: req.isDash ? 'hls' : req.sourceFormat,
    hasMuxedAudio: req.hasMuxedAudio,
    separateAudio: req.audioUrl !== undefined,
    hasVideo: req.hasVideo,
    mode: req.mode,
    container: req.container,
    audioFormat: req.audioFormat,
    audioBitrate: req.audioBitrate,
    limits,
  };
  if (req.fragmented !== undefined) input.fragmented = req.fragmented;
  if (req.videoCodec) input.videoFamily = req.videoCodec as VideoFamily;
  if (req.audioCodec) input.audioFamily = req.audioCodec as AudioFamily;
  if (req.estimatedBytes !== undefined) input.estimatedBytes = req.estimatedBytes;
  if (req.durationSec !== undefined) input.durationSec = req.durationSec;
  if (req.live !== undefined) input.live = req.live;
  return planOutput(input);
}

/** A MediaSource capture: recorded in the page, assembled by copying streams. The container is decided from the codecs. */
function planCapture(): Plan {
  return {
    valid: true,
    issues: [],
    pipeline: 'capture',
    requiresFfmpeg: true,
    video: 'copy',
    audio: 'copy',
    extension: 'mp4',
    usesBitrate: false,
  };
}

/** A capture request for a MediaSource player the scan found (`held.kind === 'mse'`). */
export function buildCaptureRequest(
  resource: MediaResource,
  settings: Settings,
  speed: 'fast' | 'realtime',
): DownloadRequest {
  const base = renderNameTemplate(settings.namingTemplate, {
    title: resource.title,
    host: resource.host,
    resolution: resolutionLabel(resource.height),
    date: new Date().toISOString().slice(0, 10),
    format: 'mp4',
    id: resource.id,
  });
  const req: DownloadRequest = {
    resourceId: resource.id,
    sourceUrl: resource.url,
    tabId: resource.tabId,
    pageUrl: resource.pageUrl,
    host: resource.host,
    mode: 'original',
    container: 'original',
    audioFormat: settings.defaultAudioFormat,
    audioBitrate: settings.defaultAudioBitrate,
    // the extension is decided from the codecs once the capture is done
    filename: withExtension(base, 'mp4'),
    subfolder: sanitizeSubfolder(settings.subfolder),
    saveAs: settings.askWhereToSave,
    qualityLabel: speed === 'fast' ? 'CAPTURE' : 'RECORD',
    sourceFormat: 'unknown',
    isHls: false,
    hasMuxedAudio: true,
    hasVideo: true,
    capture: { speed },
  };
  if (resource.held) req.held = resource.held;
  if (resource.durationSec) req.durationSec = resource.durationSec;
  return req;
}

/** ZIP archives are classic ZIP (not ZIP64): never above 4 GB, and never above the user's memory/size limit. */
export const MAX_ZIP_BYTES = 4000 * 1024 * 1024;

export function zipLimitBytes(maxMemoryMb: number): number {
  return Math.min(maxMemoryMb * 1024 * 1024, MAX_ZIP_BYTES);
}

function planZipJob(req: DownloadRequest, limits: { maxMemoryMb: number }): Plan {
  const issues: Plan['issues'] = [];
  if (req.estimatedBytes !== undefined && req.estimatedBytes > zipLimitBytes(limits.maxMemoryMb))
    issues.push('too-large');
  return {
    valid: issues.length === 0,
    issues,
    pipeline: 'zip',
    requiresFfmpeg: false,
    video: 'none',
    audio: 'none',
    extension: 'zip',
    usesBitrate: false,
  };
}

/** A plain file is Chrome's own download, as is (a data: source is staged by the page hand-over instead). */
function planPlainFile(req: DownloadRequest): Plan {
  const dot = req.filename.lastIndexOf('.');
  return {
    valid: true,
    issues: [],
    pipeline: 'native',
    requiresFfmpeg: false,
    video: 'none',
    audio: 'none',
    extension: dot > 0 ? req.filename.slice(dot + 1) : '',
    usesBitrate: false,
  };
}

/** Subtitles are small text: no FFmpeg, no size limit. A plain document saved as found is a native download. */
function planSubtitle(req: DownloadRequest): Plan {
  const segmented = req.isHls || req.isDash === true;
  const output = req.subtitle?.output ?? 'original';
  const issues: Plan['issues'] = [];
  if (req.live) issues.push('live-stream');
  return {
    valid: issues.length === 0,
    issues,
    pipeline: !segmented && output === 'original' ? 'native' : 'subtitle',
    requiresFfmpeg: false,
    video: 'none',
    audio: 'none',
    extension: subtitleExtension(req.sourceFormat, output),
    usesBitrate: false,
  };
}

/**
 * Normalise a request received over messaging: never trust the sender's filename, folder or URLs.
 * Returns undefined when a URL is unsafe.
 */
export function sanitizeRequest(req: DownloadRequest): DownloadRequest | undefined {
  // A page-held source (data: URL) is only a label here; the background matches it to its own scan, never fetches it.
  const heldSource = isDataLabel(req.sourceUrl);
  if (heldSource) {
    if (req.audioUrl !== undefined || req.isHls || req.isDash === true) return undefined;
  } else if (!isSafeFetchUrl(req.sourceUrl)) return undefined;
  if (req.audioUrl !== undefined && !isSafeFetchUrl(req.audioUrl)) return undefined;
  const dot = req.filename.lastIndexOf('.');
  const ext =
    dot > 0
      ? req.filename
          .slice(dot + 1)
          .replace(/[^a-z0-9]/gi, '')
          .slice(0, 5)
          .toLowerCase()
      : '';
  const base = sanitizeFilename(dot > 0 ? req.filename.slice(0, dot) : req.filename);
  // Cookies may only accompany requests to the page's own origin (never an origin the page merely names).
  const pageOrigin = parseUrl(req.pageUrl)?.origin;
  const origins = (req.credentialedOrigins ?? []).filter(
    (o) => o === pageOrigin && /^https?:\/\/[^/]+$/.test(o),
  );
  return {
    ...req,
    filename: ext ? `${base}.${ext}` : base,
    subfolder: sanitizeSubfolder(req.subfolder),
    credentialedOrigins: origins,
    // Only the background may decide which frame's headers a job replays, and what the page holds.
    replay: undefined,
    held: undefined,
    capture:
      req.capture && (req.capture.speed === 'fast' || req.capture.speed === 'realtime')
        ? { speed: req.capture.speed }
        : undefined,
    // The names and URLs inside a ZIP are the background's to decide.
    zip: sanitizeZip(req.zip),
    ...(req.file && isFileKind(req.file.kind) ? { file: { kind: req.file.kind } } : { file: undefined }),
  };
}

function sanitizeZip(zip: DownloadRequest['zip']): DownloadRequest['zip'] {
  if (!zip || !Array.isArray(zip.resourceIds)) return undefined;
  const ids = zip.resourceIds
    .filter((x): x is string => typeof x === 'string' && x.length <= 64)
    .slice(0, MAX_ZIP_ITEMS);
  return ids.length > 0 ? { resourceIds: ids } : undefined;
}
