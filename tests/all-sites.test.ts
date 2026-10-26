import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_SITES_ACCESS, requestAllSites } from '@/lib/uiActions';
import { installFakeChrome } from './helpers/fake-chrome';

let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  installFakeChrome();
  request = vi.fn(async () => true);
  (globalThis as unknown as { chrome: { permissions: unknown } }).chrome.permissions = { request };
});

describe('requestAllSites (VDH-049)', () => {
  it('asks once for every site, with header replay, so every embedded player is unlocked', async () => {
    expect(await requestAllSites()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(ALL_SITES_ACCESS);
    expect(ALL_SITES_ACCESS).toEqual({
      origins: ['<all_urls>'],
      permissions: ['declarativeNetRequestWithHostAccess'],
    });
  });
  it('a refusal or an error is a plain "no"', async () => {
    request.mockResolvedValueOnce(false);
    expect(await requestAllSites()).toBe(false);
    request.mockRejectedValueOnce(new Error('no gesture'));
    expect(await requestAllSites()).toBe(false);
  });
});
