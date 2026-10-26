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
  askWhereToSave: false,
  autoScan: false,
  pageHook: true,
  networkObserver: false,
  imageMinPx: 100,
  maxConcurrentDownloads: 2,
  segmentConcurrency: 4,
  maxMemoryMb: 2048,
  maxEncodeDurationSec: 0,
  recordContainer: 'webm',
  recordMaxMinutes: 120,
  recordMaxMb: 4096,
  notifyOnComplete: true,
  notifyOnError: true,
};

const MODES: OutputMode[] = ['video-audio', 'audio-only', 'video-only', 'original'];
const QUALITIES: QualityPreset[] = ['highest', '2160', '1440', '1080', '720', '480', '360'];
const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'm4a', 'aac', 'wav'];
const BITRATES: AudioBitrate[] = [128, 192, 256, 320];

export const IMAGE_MIN_CHOICES = [0, 100, 300, 800] as const;

export const LIMITS = {
  maxConcurrentDownloads: { min: 1, max: 5 },
  segmentConcurrency: { min: 1, max: 8 },
  maxMemoryMb: { min: 128, max: 8192 },
  maxEncodeDurationSec: { min: 0, max: 86_400 },
  recordMaxMinutes: { min: 1, max: 1440 },
  recordMaxMb: { min: 64, max: 16_384 },
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
    askWhereToSave: bool(r['askWhereToSave'], d.askWhereToSave),
    autoScan: bool(r['autoScan'], d.autoScan),
    pageHook: bool(r['pageHook'], d.pageHook),
    networkObserver: bool(r['networkObserver'], d.networkObserver),
    imageMinPx: oneOf(r['imageMinPx'], IMAGE_MIN_CHOICES, d.imageMinPx),
    maxConcurrentDownloads: int(
      r['maxConcurrentDownloads'],
      LIMITS.maxConcurrentDownloads,
      d.maxConcurrentDownloads,
    ),
    segmentConcurrency: int(r['segmentConcurrency'], LIMITS.segmentConcurrency, d.segmentConcurrency),
    maxMemoryMb: int(r['maxMemoryMb'], LIMITS.maxMemoryMb, d.maxMemoryMb),
    maxEncodeDurationSec: int(r['maxEncodeDurationSec'], LIMITS.maxEncodeDurationSec, d.maxEncodeDurationSec),
    recordContainer: oneOf(r['recordContainer'], ['webm', 'mp4'] as const, d.recordContainer),
    recordMaxMinutes: int(r['recordMaxMinutes'], LIMITS.recordMaxMinutes, d.recordMaxMinutes),
    recordMaxMb: int(r['recordMaxMb'], LIMITS.recordMaxMb, d.recordMaxMb),
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

let writes: Promise<unknown> = Promise.resolve();

/**
 * Merge a partial update into the stored settings and persist the validated result. Writes are queued so two
 * quick updates (e.g. a select, then typing in a field) can never overwrite each other.
 */
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = writes.then(async () => {
    const current = await loadSettings();
    const next = sanitizeSettings({ ...current, ...patch });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
  writes = run.catch(() => undefined);
  return run;
}

export function resetSettings(): Promise<Settings> {
  const run = writes.then(async () => {
    const next = { ...DEFAULT_SETTINGS };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
  writes = run.catch(() => undefined);
  return run;
}

/** Storage key of the one-time migrations already applied to this install. */
export const MIGRATIONS_KEY = 'migrations';
/** "Look inside players" became on by default (VDH-049); installs that had it off get it on once. */
export const HOOK_DEFAULT_ON = 'hookDefaultOn';

/**
 * The stored settings after the hook-default migration: switched on once, then never touched again (a user who turns it
 * off afterwards keeps it off). Nothing stored means the defaults apply, which already have it on.
 */
export function migrateHookDefault(
  stored: unknown,
  applied: readonly string[],
): Record<string, unknown> | undefined {
  if (applied.includes(HOOK_DEFAULT_ON)) return undefined;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined;
  return { ...(stored as Record<string, unknown>), pageHook: true };
}

/** Run the one-time migrations on install or update. A new install only records them as applied. */
export async function runMigrations(reason: string): Promise<void> {
  const run = writes.then(async () => {
    const got = await chrome.storage.local.get([MIGRATIONS_KEY, SETTINGS_KEY]);
    const raw: unknown = got[MIGRATIONS_KEY];
    const applied = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : [];
    if (applied.includes(HOOK_DEFAULT_ON)) return;
    const next = reason === 'update' ? migrateHookDefault(got[SETTINGS_KEY], applied) : undefined;
    await chrome.storage.local.set({
      ...(next ? { [SETTINGS_KEY]: sanitizeSettings(next) } : {}),
      [MIGRATIONS_KEY]: [...applied, HOOK_DEFAULT_ON],
    });
  });
  writes = run.catch(() => undefined);
  return run;
}

/** Picks the variant to preselect for a quality preset: the best at or below the preset, else the lowest. */
export function pickVariantIndex(heights: Array<number | undefined>, preset: QualityPreset): number {
  if (heights.length === 0) return -1;
  if (preset === 'highest') return 0; // variants are sorted best-first
  const cap = Number(preset);
  const idx = heights.findIndex((h) => h === undefined || h <= cap);
  return idx === -1 ? heights.length - 1 : idx;
}
