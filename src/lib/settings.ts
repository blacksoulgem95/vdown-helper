import type { QualityPreset, Settings } from '@/types/settings';
import { core } from './core';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  defaultMode: 'video-audio',
  defaultContainer: 'mp4',
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

/**
 * Validates arbitrary stored data into a complete, in-range Settings object. Unknown keys are dropped. Implemented in
 * Rust (`core/src/settings.rs`), shared with the desktop app; `DEFAULT_SETTINGS` and `LIMITS` above must match it (a
 * unit test checks).
 */
export function sanitizeSettings(raw: unknown): Settings {
  return core.sanitizeSettings(raw) as Settings;
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
  return core.migrateHookDefault(stored, [...applied]) as Record<string, unknown> | undefined;
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
  return core.pickVariantIndex(heights, preset);
}
