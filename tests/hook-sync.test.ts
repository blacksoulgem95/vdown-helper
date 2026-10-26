import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncHook } from '@/background/hooks';
import { SETTINGS_KEY } from '@/lib/settings';
import { installFakeChrome, type FakeChrome } from './helpers/fake-chrome';

let fake: FakeChrome;
let registered: Array<{ id: string; matches: string[] }>;
let release: Array<() => void>;

beforeEach(() => {
  fake = installFakeChrome();
  registered = [];
  release = [];
  const c = globalThis as unknown as { chrome: Record<string, unknown> };
  c.chrome['permissions'] = { getAll: async () => ({ origins: ['http://127.0.0.1/*'] }) };
  c.chrome['scripting'] = {
    getRegisteredContentScripts: vi.fn(async () => registered.map((r) => ({ ...r }))),
    // The first registration is held until the test lets it go, the way a slow browser call would be.
    registerContentScripts: vi.fn(
      (scripts: Array<{ id: string; matches: string[] }>) =>
        new Promise<void>((resolve) => {
          const done = () => {
            registered.push(...scripts);
            resolve();
          };
          if (release.length === 0) release.push(done);
          else done();
        }),
    ),
    updateContentScripts: vi.fn(async () => undefined),
    unregisterContentScripts: vi.fn(async () => {
      registered = [];
    }),
  };
});

describe('syncHook (VDH-049)', () => {
  it('overlapping calls run in order: turning the hook off right after on leaves it unregistered', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, pageHook: true };
    const on = syncHook();
    await vi.waitFor(() => expect(release).toHaveLength(1));
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, pageHook: false };
    const off = syncHook();
    // Give the second call every chance to finish first, as it would in the browser.
    await new Promise((r) => setTimeout(r, 30));
    (release[0] as () => void)();
    expect(await on).toBe(true);
    expect(await off).toBe(false);
    expect(registered).toEqual([]);
  });
});
