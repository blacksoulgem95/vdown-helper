import type { Fetcher } from '@/lib/analyze';
import { fetchText, probeHeaders, type ProbeResult } from '@/lib/netprobe';
import type { ScanReport } from '@/types/media';
import type { VdhApi } from '@/content/scanner';
import { mayExtensionFetch, parseUrl } from '@/lib/security';
import { withReplay } from './replay';

type ApiCall = 'scan' | 'probeHeaders' | 'fetchText';

/**
 * Inject the (read-only) scanner into every frame Chrome lets us into: the top frame (activeTab), same-origin
 * frames, and, where the user granted access, cross-origin and nested frames. Frames we may not enter are skipped.
 */
export async function injectScanner(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
}

async function callPage<T>(
  tabId: number,
  frameId: number | undefined,
  name: ApiCall,
  arg?: string,
): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId ?? 0] },
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

/** One report per frame that could be scanned; each carries the frame id it came from. */
export async function pageScanAll(tabId: number): Promise<ScanReport[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const api = (globalThis as unknown as { __vdh?: { scan?: () => unknown; scanAsync?: () => unknown } })
        .__vdh;
      // scanAsync also reads the blob: sources the page holds; both return a scan report
      return api?.scanAsync ? api.scanAsync() : api?.scan ? api.scan() : null;
    },
  });
  return results.filter((r) => r.result).map((r) => ({ ...(r.result as ScanReport), frameId: r.frameId }));
}

/**
 * Fetches made from the owning frame's origin and cookies: sees exactly what that frame's player can see.
 * Falls back to the top frame when the frame has no scanner (e.g. access was not granted).
 */
export function pageFetcher(tabId: number): Fetcher {
  const call = async (name: ApiCall, url: string, frameId?: number): Promise<ProbeResult> => {
    try {
      return await callPage<ProbeResult>(tabId, frameId, name, url);
    } catch {
      return { ok: false, kind: 'blocked' };
    }
  };
  return {
    head: (url, frameId) => call('probeHeaders', url, frameId),
    text: (url, frameId) => call('fetchText', url, frameId),
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

/**
 * Extension-origin fetches. They are exempt from CORS for origins the user granted, so they are restricted:
 * cookies are only attached for the page's own origin, and private-network targets are refused unless the page
 * itself lives on one.
 */
export function extensionFetcher(pageUrl: string): Fetcher {
  const pageOrigin = parseUrl(pageUrl)?.origin;
  const creds = (url: string): RequestCredentials =>
    parseUrl(url)?.origin === pageOrigin ? 'include' : 'omit';
  const blocked = (): ProbeResult => ({ ok: false, kind: 'blocked' });
  return {
    head: (url) =>
      mayExtensionFetch(url, pageUrl) ? probeHeaders(url, fetch, creds(url)) : Promise.resolve(blocked()),
    text: (url) =>
      mayExtensionFetch(url, pageUrl) ? fetchText(url, fetch, creds(url)) : Promise.resolve(blocked()),
  };
}

/**
 * Page first (same rules as the page's player). If the page is blocked by cross-origin policy and the user has
 * granted access to that origin, retry from the extension. `allowExtensionFallback` is false for automatic scans:
 * nothing may reach out beyond what the page itself can read without the user asking for it.
 */
export function combinedFetcher(
  tabId: number,
  pageUrl: string,
  allowExtensionFallback = true,
  /** frameId -> document URL of that frame, so the fallback can replay the frame's Referer/Origin. */
  frameUrls: ReadonlyMap<number, string> = new Map(),
): Fetcher {
  const page = pageFetcher(tabId);
  const ext = extensionFetcher(pageUrl);
  const withFallback = async (
    url: string,
    which: 'head' | 'text',
    frameId?: number,
  ): Promise<ProbeResult> => {
    const first = await page[which](url, frameId);
    if (first.ok || first.kind === 'http' || !allowExtensionFallback) return first;
    if (await hasHostAccess(url)) {
      const frameUrl = frameId !== undefined ? frameUrls.get(frameId) : undefined;
      return withReplay(`probe:${tabId}:${frameId ?? 0}:${which}:${url}`, frameUrl, [url], () =>
        ext[which](url),
      );
    }
    return first;
  };
  return {
    head: (u, f) => withFallback(u, 'head', f),
    text: (u, f) => withFallback(u, 'text', f),
  };
}

export type { VdhApi };

/**
 * Ask the owning frame to send the bytes it holds (a data: URL) to the offscreen document of `jobId`. The offscreen
 * document must already be expecting them. Resolves when the page has finished sending, or with the reason it could not.
 */
export async function pumpHeld(
  tabId: number,
  frameId: number,
  jobId: string,
  handle: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (j: string, h: string) => {
        const api = (globalThis as unknown as { __vdh?: { pumpHeld?: (a: string, b: string) => unknown } })
          .__vdh;
        return api?.pumpHeld ? api.pumpHeld(j, h) : { ok: false, error: 'The page scanner is not available' };
      },
      args: [jobId, handle],
    });
    const r = res?.result as { ok?: boolean; error?: string } | undefined;
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'The page could not send the data' };
  } catch {
    return { ok: false, error: 'The page is no longer available' };
  }
}
