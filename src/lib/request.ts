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
import { planOutput, type Plan, type PlanInput } from './compat';
import {
  describeCodecs,
  estimateBytes,
  formatFromMime,
  resolutionLabel,
  type AudioFamily,
  type VideoFamily,
} from './media';
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
    filename: '',
  };
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
  const variant = resource.kind === 'hls-master' ? resource.variants[choices.variantIndex] : undefined;
  const audioOpts = audioOptions(resource, variant);
  const audioTrack = choices.audioIndex >= 0 ? audioOpts[choices.audioIndex] : undefined;
  const audioOnlyMaster = resource.kind === 'hls-master' && resource.variants.length === 0;
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
  if (choices.mode === 'audio-only' && resource.kind === 'hls-master') {
    if (audioUrl) {
      // Fetch only the audio rendition instead of the whole video.
      sourceUrl = audioUrl;
      audioUrl = undefined;
      codecs = audioTrack ? undefined : codecs;
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
  const estimated = isHls ? estimateBytes(bandwidth, duration) : resource.sizeBytes;

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
      : resource.format !== 'unknown'
        ? resource.format
        : (formatFromMime(resource.mimeType) ?? 'unknown'),
    isHls,
    hasMuxedAudio,
    hasVideo,
  };
  if (audioUrl) req.audioUrl = audioUrl;
  if (isHls && resource.kind === 'hls-master') req.masterUrl = resource.url;
  if (inspection) {
    req.fragmented = inspection.fragmented;
    req.live = inspection.live;
  } else if (resource.playlist) {
    if (resource.playlist.fragmented !== undefined) req.fragmented = resource.playlist.fragmented;
    if (resource.playlist.live !== undefined) req.live = resource.playlist.live;
  }
  if (fam.video) req.videoCodec = fam.video;
  if (fam.audio) req.audioCodec = fam.audio;
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
  const input: PlanInput = {
    isHls: req.isHls,
    sourceFormat: req.sourceFormat,
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

/**
 * Normalise a request received over messaging: never trust the sender's filename, folder or URLs.
 * Returns undefined when a URL is unsafe.
 */
export function sanitizeRequest(req: DownloadRequest): DownloadRequest | undefined {
  if (!isSafeFetchUrl(req.sourceUrl)) return undefined;
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
    // Only the background may decide which frame's headers a job replays.
    replay: undefined,
  };
}
