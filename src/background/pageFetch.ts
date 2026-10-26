import type { Fetcher } from '@/lib/analyze';
import { fetchText, probeHeaders, type ProbeResult } from '@/lib/netprobe';
import type { ScanReport } from '@/types/media';
import type { VdhApi } from '@/content/scanner';
import { parseUrl } from '@/lib/security';

type ApiCall = 'scan' | 'probeHeaders' | 'fetchText';

/** Inject the (read-only) scanner into the tab's top frame. Requires activeTab or host access. */
export async function injectScanner(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function callPage<T>(tabId: number, name: ApiCall, arg?: string): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    // Self-contained: serialised and run in the page's isolated world.
    func: (n: string, a?: string) => {
      const api = (globalThis as unknown as { __vdh?: Record<string, (x?: string) => unknown> }).__vdh;
      if (!api || typeof api[n] !== 'function') throw new Error('scanner-missing');
      return api[n](a);
    },
    args: arg === undefined ? [name] : [name, arg],
  });
  return res?.result as T;
}

export const pageScan = (tabId: number) => callPage<ScanReport>(tabId, 'scan');

/** Fetches made from the page's own origin and cookies: sees exactly what the page's player can see. */
export function pageFetcher(tabId: number): Fetcher {
  return {
    head: (url) =>
      callPage<ProbeResult>(tabId, 'probeHeaders', url).catch(
        () => ({ ok: false, kind: 'blocked' }) as ProbeResult,
      ),
    text: (url) =>
      callPage<ProbeResult>(tabId, 'fetchText', url).catch(
        () => ({ ok: false, kind: 'blocked' }) as ProbeResult,
      ),
  };
}

/** True when the user has granted the extension access to this URL's origin (optional host permission). */
export async function hasHostAccess(url: string): Promise<boolean> {
  const u = parseUrl(url);
  if (!u) return false;
  try {
    return await chrome.permissions.contains({ origins: [`${u.origin}/*`] });
  } catch {
    return false;
  }
}

/** Extension-origin fetches with cookies. Only meaningful for origins with granted host access. */
export function extensionFetcher(): Fetcher {
  return {
    head: (url) => probeHeaders(url, fetch, 'include'),
    text: (url) => fetchText(url, fetch, 'include'),
  };
}

/**
 * Page first (same rules as the page's player). If the page is blocked by cross-origin policy and the user has
 * granted access to that origin, retry from the extension, which is then exempt from CORS.
 */
export function combinedFetcher(tabId: number): Fetcher {
  const page = pageFetcher(tabId);
  const ext = extensionFetcher();
  const withFallback = async (url: string, which: 'head' | 'text'): Promise<ProbeResult> => {
    const first = await page[which](url);
    if (first.ok || first.kind === 'http') return first;
    if (await hasHostAccess(url)) return ext[which](url);
    return first;
  };
  return { head: (u) => withFallback(u, 'head'), text: (u) => withFallback(u, 'text') };
}

export type { VdhApi };
