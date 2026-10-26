import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  HOOK_DEFAULT_ON,
  MIGRATIONS_KEY,
  loadSettings,
  migrateHookDefault,
  pickVariantIndex,
  runMigrations,
  resetSettings,
  sanitizeSettings,
  saveSettings,
} from '@/lib/settings';
import { installFakeChrome, type FakeChrome } from './helpers/fake-chrome';

let fake: FakeChrome;
beforeEach(() => {
  fake = installFakeChrome();
});

describe('sanitizeSettings', () => {
  it('returns defaults for garbage input', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });
  it('rejects invalid enum values and wrong types per field', () => {
    const s = sanitizeSettings({
      defaultMode: 'nope',
      preferredQuality: 5,
      autoScan: 'yes',
      defaultAudioBitrate: 999,
    });
    expect(s.defaultMode).toBe(DEFAULT_SETTINGS.defaultMode);
    expect(s.preferredQuality).toBe(DEFAULT_SETTINGS.preferredQuality);
    expect(s.autoScan).toBe(false);
    expect(s.defaultAudioBitrate).toBe(192);
  });
  it('clamps numeric limits', () => {
    const s = sanitizeSettings({
      maxConcurrentDownloads: 99,
      segmentConcurrency: 0,
      maxMemoryMb: 1,
      maxEncodeDurationSec: -5,
    });
    expect(s).toMatchObject({
      maxConcurrentDownloads: 5,
      segmentConcurrency: 1,
      maxMemoryMb: 128,
      maxEncodeDurationSec: 0,
    });
  });
  it('keeps recording limits and the recording format in range', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      recordContainer: 'webm',
      recordMaxMinutes: 120,
      recordMaxMb: 4096,
    });
    expect(sanitizeSettings({ recordMaxMinutes: 0, recordMaxMb: 1e9, recordContainer: 'avi' })).toMatchObject(
      {
        recordMaxMinutes: 1,
        recordMaxMb: 16384,
        recordContainer: 'webm',
      },
    );
    expect(sanitizeSettings({ recordContainer: 'mp4' }).recordContainer).toBe('mp4');
  });
  it('sanitises the sub-folder and bounds the template', () => {
    expect(sanitizeSettings({ subfolder: '../../evil/x' }).subfolder).toBe('evil/x');
    expect(sanitizeSettings({ namingTemplate: 'x'.repeat(999) }).namingTemplate).toHaveLength(200);
    expect(sanitizeSettings({ namingTemplate: '   ' }).namingTemplate).toBe(DEFAULT_SETTINGS.namingTemplate);
  });
  it('drops unknown keys', () => {
    expect(sanitizeSettings({ evil: 1 })).not.toHaveProperty('evil');
  });
});

describe('persistence through chrome.storage.local', () => {
  it('loads defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('round-trips a saved patch', async () => {
    const saved = await saveSettings({
      defaultMode: 'audio-only',
      maxConcurrentDownloads: 4,
      notifyOnComplete: false,
    });
    expect(saved.defaultMode).toBe('audio-only');
    expect(await loadSettings()).toEqual(saved);
    expect(
      (fake.storage.local.data[SETTINGS_KEY] as { maxConcurrentDownloads: number }).maxConcurrentDownloads,
    ).toBe(4);
  });
  it('merges successive patches', async () => {
    await saveSettings({ autoScan: true });
    await saveSettings({ subfolder: 'vdown' });
    expect(await loadSettings()).toMatchObject({ autoScan: true, subfolder: 'vdown' });
  });
  it('falls back to defaults when stored data is corrupt', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { defaultMode: 42, maxMemoryMb: 'big' };
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('validates values on save too', async () => {
    const s = await saveSettings({ maxMemoryMb: 10_000_000 });
    expect(s.maxMemoryMb).toBe(8192);
  });
  it('quick successive updates never overwrite each other', async () => {
    await Promise.all([
      saveSettings({ defaultMode: 'audio-only' }),
      saveSettings({ namingTemplate: '{host}' }),
      saveSettings({ subfolder: 'a' }),
    ]);
    expect(await loadSettings()).toMatchObject({
      defaultMode: 'audio-only',
      namingTemplate: '{host}',
      subfolder: 'a',
    });
  });
  it('reset restores defaults', async () => {
    await saveSettings({ autoScan: true });
    expect(await resetSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('page hook default (VDH-049)', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.pageHook).toBe(true);
    expect(sanitizeSettings({}).pageHook).toBe(true);
    expect(sanitizeSettings({ pageHook: false }).pageHook).toBe(false);
  });
  it('migrateHookDefault switches stored settings on once, and leaves nothing-stored to the defaults', () => {
    expect(migrateHookDefault({ schemaVersion: 1, pageHook: false, subfolder: 'x' }, [])).toEqual({
      schemaVersion: 1,
      pageHook: true,
      subfolder: 'x',
    });
    expect(migrateHookDefault(undefined, [])).toBeUndefined();
    expect(migrateHookDefault([1], [])).toBeUndefined();
    expect(migrateHookDefault({ pageHook: false }, [HOOK_DEFAULT_ON])).toBeUndefined();
  });
  it('an update turns a stored "off" on once; switching it off again afterwards sticks', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, pageHook: false, subfolder: 'keep' };
    await runMigrations('update');
    expect(await loadSettings()).toMatchObject({ pageHook: true, subfolder: 'keep' });
    expect(fake.storage.local.data[MIGRATIONS_KEY]).toEqual([HOOK_DEFAULT_ON]);
    await saveSettings({ pageHook: false });
    await runMigrations('update');
    expect((await loadSettings()).pageHook).toBe(false);
  });
  it('a new install only records the migration; an update with nothing stored writes no settings', async () => {
    await runMigrations('install');
    expect(fake.storage.local.data[MIGRATIONS_KEY]).toEqual([HOOK_DEFAULT_ON]);
    expect(fake.storage.local.data[SETTINGS_KEY]).toBeUndefined();
    fake.storage.local.data = {};
    await runMigrations('update');
    expect(fake.storage.local.data[SETTINGS_KEY]).toBeUndefined();
    expect((await loadSettings()).pageHook).toBe(true);
  });
});

describe('pickVariantIndex', () => {
  const heights = [1080, 720, 480, 360];
  it.each([
    ['highest', 0],
    ['720', 1],
    ['1080', 0],
    ['360', 3],
  ] as const)('preset %s -> %i', (preset, idx) => expect(pickVariantIndex(heights, preset)).toBe(idx));
  it('falls back to the lowest when everything is above the cap', () => {
    expect(pickVariantIndex([2160, 1440], '720')).toBe(1);
  });
  it('returns -1 for no variants', () => {
    expect(pickVariantIndex([], 'highest')).toBe(-1);
  });
});
