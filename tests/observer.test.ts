import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_KEY } from '@/lib/settings';
import { FakeEvent, installFakeChrome, type FakeChrome } from './helpers/fake-chrome';

type Details = {
  tabId: number;
  frameId: number;
  url: string;
  responseHeaders?: { name: string; value: string }[];
};
let fake: FakeChrome;
let onHeaders: FakeEvent<[Details]>;

beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
  onHeaders = new FakeEvent<[Details]>();
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome['webRequest'] = {
    onHeadersReceived: onHeaders,
  };
});

const hls = (url: string): Details => ({
  tabId: 7,
  frameId: 0,
  url,
  responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }],
});
const observed = async () =>
  (await chrome.storage.session.get('net:7'))['net:7'] as { url: string }[] | undefined;
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('network observer (VDH-053)', () => {
  it('registers its listener synchronously, so a request that wakes the worker is not missed', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, networkObserver: true };
    const { initObserver } = await import('@/background/observer');
    initObserver();
    expect(onHeaders.listeners.size).toBe(1); // no await between start and registration
    // the request arrives before anything has read the settings
    onHeaders.emit(hls('https://cdn.example/hls/a,b,c,.urlset/master.m3u8'));
    await settle();
    expect((await observed())?.map((o) => o.url)).toEqual([
      'https://cdn.example/hls/a,b,c,.urlset/master.m3u8',
    ]);
  });

  it('keeps every request of a burst (master and variants within the same moment)', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, networkObserver: true };
    const { initObserver } = await import('@/background/observer');
    initObserver();
    const urls = ['master', 'v1', 'v2', 'v3', 'v4'].map((n) => `https://cdn.example/hls/${n}.m3u8`);
    for (const u of urls) onHeaders.emit(hls(u));
    await settle();
    expect((await observed())?.map((o) => o.url).sort()).toEqual([...urls].sort());
  });

  it('records nothing when the user has the observer off', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, networkObserver: false };
    const { initObserver } = await import('@/background/observer');
    initObserver();
    onHeaders.emit(hls('https://cdn.example/hls/master.m3u8'));
    await settle();
    expect(await observed()).toBeUndefined();
  });

  it('without the webRequest permission there is nothing to register', async () => {
    delete (globalThis as unknown as { chrome: Record<string, unknown> }).chrome['webRequest'];
    const { initObserver, setObserverEnabled, isObserving } = await import('@/background/observer');
    initObserver();
    expect(setObserverEnabled(true)).toBe(false);
    expect(isObserving()).toBe(false);
  });
});
