import type { AudioBitrate, AudioFormat, OutputMode } from '@/types/download';
import type { QualityPreset, Settings } from '@/types/settings';
import { sanitizeSubfolder } from './security';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  defaultMode: 'video-audio',
  preferredQuality: 'highest',
  defaultAudioFormat: 'mp3',
  defaultAudioBitrate: 192,
  namingTemplate: '{title} [{resolution}]',
  subfolder: '',
  autoScan: false,
  networkObserver: false,
  maxConcurrentDownloads: 2,
  segmentConcurrency: 4,
  maxMemoryMb: 2048,
  maxEncodeDurationSec: 0,
  notifyOnComplete: true,
  notifyOnError: true,
};

const MODES: OutputMode[] = ['video-audio', 'audio-only', 'video-only', 'original'];
const QUALITIES: QualityPreset[] = ['highest', '2160', '1440', '1080', '720', '480', '360'];
const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'm4a', 'aac', 'wav'];
const BITRATES: AudioBitrate[] = [128, 192, 256, 320];

export const LIMITS = {
  maxConcurrentDownloads: { min: 1, max: 5 },
  segmentConcurrency: { min: 1, max: 8 },
  maxMemoryMb: { min: 128, max: 8192 },
  maxEncodeDurationSec: { min: 0, max: 86_400 },
  namingTemplate: { maxLength: 200 },
} as const;

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function int(v: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(v)));
}

/** Validates arbitrary stored data into a complete, in-range Settings object. Unknown keys are dropped. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const template =
    typeof r['namingTemplate'] === 'string' && r['namingTemplate'].trim()
      ? r['namingTemplate'].slice(0, LIMITS.namingTemplate.maxLength)
      : d.namingTemplate;
  return {
    schemaVersion: 1,
    defaultMode: oneOf(r['defaultMode'], MODES, d.defaultMode),
    preferredQuality: oneOf(r['preferredQuality'], QUALITIES, d.preferredQuality),
    defaultAudioFormat: oneOf(r['defaultAudioFormat'], AUDIO_FORMATS, d.defaultAudioFormat),
    defaultAudioBitrate: oneOf(r['defaultAudioBitrate'], BITRATES, d.defaultAudioBitrate),
    namingTemplate: template,
    subfolder: typeof r['subfolder'] === 'string' ? sanitizeSubfolder(r['subfolder']) : d.subfolder,
    autoScan: bool(r['autoScan'], d.autoScan),
    networkObserver: bool(r['networkObserver'], d.networkObserver),
    maxConcurrentDownloads: int(r['maxConcurrentDownloads'], LIMITS.maxConcurrentDownloads, d.maxConcurrentDownloads),
    segmentConcurrency: int(r['segmentConcurrency'], LIMITS.segmentConcurrency, d.segmentConcurrency),
    maxMemoryMb: int(r['maxMemoryMb'], LIMITS.maxMemoryMb, d.maxMemoryMb),
    maxEncodeDurationSec: int(r['maxEncodeDurationSec'], LIMITS.maxEncodeDurationSec, d.maxEncodeDurationSec),
    notifyOnComplete: bool(r['notifyOnComplete'], d.notifyOnComplete),
    notifyOnError: bool(r['notifyOnError'], d.notifyOnError),
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitizeSettings(stored[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merge a partial update into the stored settings and persist the validated result. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings(): Promise<Settings> {
  const next = { ...DEFAULT_SETTINGS };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Picks the variant to preselect for a quality preset: the best at or below the preset, else the lowest. */
export function pickVariantIndex(heights: Array<number | undefined>, preset: QualityPreset): number {
  if (heights.length === 0) return -1;
  if (preset === 'highest') return 0; // variants are sorted best-first
  const cap = Number(preset);
  const idx = heights.findIndex((h) => h === undefined || h <= cap);
  return idx === -1 ? heights.length - 1 : idx;
}
