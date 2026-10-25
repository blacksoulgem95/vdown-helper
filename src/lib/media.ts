import type { MediaFormat } from '@/types/media';
import { parseUrl } from './security';

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBitrate(bitsPerSecond: number | undefined): string {
  if (bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '';
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

export function formatSpeed(bytesPerSecond: number | undefined): string {
  const b = formatBytes(bytesPerSecond);
  return b ? `${b}/s` : '';
}

/** Resolution tier derived from the *actual* pixel height. Used only to label variants that exist. */
export function qualityTag(height: number | undefined): string {
  if (!height) return '';
  if (height >= 2160) return '4K UHD';
  if (height >= 1440) return 'QHD';
  if (height >= 1080) return 'Full HD';
  if (height >= 720) return 'HD';
  if (height >= 480) return 'SD';
  return 'Low';
}

export function resolutionLabel(height: number | undefined, width?: number): string {
  if (height) return `${height}p`;
  if (width) return `${width}w`;
  return '';
}

const MIME_TO_FORMAT: Record<string, MediaFormat> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'application/vnd.apple.mpegurl': 'hls',
  'application/x-mpegurl': 'hls',
  'audio/mpegurl': 'm3u',
  'audio/x-mpegurl': 'm3u',
  'application/dash+xml': 'dash',
};

const EXT_TO_FORMAT: Record<string, MediaFormat> = {
  mp4: 'mp4',
  m4v: 'mp4',
  webm: 'webm',
  mkv: 'mkv',
  mov: 'mov',
  ogv: 'ogv',
  ts: 'ts',
  mp3: 'mp3',
  m4a: 'm4a',
  aac: 'aac',
  wav: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  flac: 'flac',
  m3u8: 'hls',
  m3u: 'm3u',
  mpd: 'dash',
};

export function formatFromMime(mime: string | undefined): MediaFormat | undefined {
  if (!mime) return undefined;
  const key = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_TO_FORMAT[key];
}

export function extensionOf(url: string): string {
  const u = parseUrl(url);
  if (!u) return '';
  const last = u.pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

export function formatFromUrl(url: string): MediaFormat | undefined {
  return EXT_TO_FORMAT[extensionOf(url)];
}

export const AUDIO_ONLY_FORMATS: ReadonlySet<MediaFormat> = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac']);

export function mediaTypeOf(format: MediaFormat): 'video' | 'audio' | 'unknown' {
  if (AUDIO_ONLY_FORMATS.has(format)) return 'audio';
  if (['mp4', 'webm', 'mkv', 'mov', 'ogv', 'ts', 'hls'].includes(format)) return 'video';
  return 'unknown';
}

/** Best-effort title from explicit title, page title, or the URL's last path segment. */
export function inferTitle(opts: { url: string; elementTitle?: string; pageTitle?: string }): string {
  const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const el = clean(opts.elementTitle);
  if (el) return el;
  const u = parseUrl(opts.url);
  if (u) {
    const seg = decodeSafe(u.pathname.split('/').filter(Boolean).pop() ?? '');
    const base = seg.replace(/\.[a-z0-9]{2,5}$/i, '');
    // Generic segment names (index, master, playlist, 12345.ts) are less useful than the page title.
    const generic = /^(index|master|playlist|manifest|video|stream|main|chunklist|media|\d+|[0-9a-f]{16,})$/i;
    if (base && !generic.test(base)) return clean(base.replace(/[_]+/g, ' '));
  }
  const page = clean(opts.pageTitle);
  if (page) return page;
  return u ? u.hostname : 'media';
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type VideoFamily = 'h264' | 'hevc' | 'av1' | 'vp9' | 'vp8' | 'mpeg4' | 'unknown';
export type AudioFamily = 'aac' | 'mp3' | 'ac3' | 'eac3' | 'opus' | 'vorbis' | 'flac' | 'unknown';

export interface CodecInfo {
  video?: { family: VideoFamily; label: string };
  audio?: { family: AudioFamily; label: string };
}

export function describeCodecs(codecs: string | undefined): CodecInfo {
  const info: CodecInfo = {};
  if (!codecs) return info;
  for (const raw of codecs.split(',')) {
    const c = raw.trim().toLowerCase();
    if (!c) continue;
    if (/^avc[1-4]/.test(c)) info.video ??= { family: 'h264', label: 'H.264' };
    else if (/^(hvc1|hev1)/.test(c)) info.video ??= { family: 'hevc', label: 'H.265' };
    else if (/^(dvh1|dvhe)/.test(c)) info.video ??= { family: 'hevc', label: 'Dolby Vision (HEVC)' };
    else if (/^av01/.test(c)) info.video ??= { family: 'av1', label: 'AV1' };
    else if (/^vp0?9/.test(c)) info.video ??= { family: 'vp9', label: 'VP9' };
    else if (/^vp0?8/.test(c)) info.video ??= { family: 'vp8', label: 'VP8' };
    else if (/^mp4v/.test(c)) info.video ??= { family: 'mpeg4', label: 'MPEG-4' };
    else if (/^mp4a\.40\.(2|5|29|42)/.test(c)) info.audio ??= { family: 'aac', label: 'AAC' };
    else if (/^mp4a\.6b|^mp4a\.69|^\.?mp3/.test(c)) info.audio ??= { family: 'mp3', label: 'MP3' };
    else if (c === 'ac-3') info.audio ??= { family: 'ac3', label: 'AC-3' };
    else if (c === 'ec-3') info.audio ??= { family: 'eac3', label: 'E-AC-3' };
    else if (c === 'opus') info.audio ??= { family: 'opus', label: 'Opus' };
    else if (c === 'vorbis') info.audio ??= { family: 'vorbis', label: 'Vorbis' };
    else if (c === 'flac') info.audio ??= { family: 'flac', label: 'FLAC' };
    else if (c.startsWith('mp4a')) info.audio ??= { family: 'unknown', label: 'MPEG-4 Audio' };
  }
  return info;
}

/** bits/s x seconds -> bytes. Callers must label the result as an estimate. */
export function estimateBytes(bitsPerSecond: number | undefined, durationSec: number | undefined): number | undefined {
  if (!bitsPerSecond || !durationSec || bitsPerSecond <= 0 || durationSec <= 0) return undefined;
  return Math.round((bitsPerSecond * durationSec) / 8);
}
