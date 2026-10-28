import { DeadlineError, withDeadline } from '@/lib/deadline';
import type { Fetcher } from '@/lib/analyze';
import { fetchText, probeHeaders, type ProbeResult } from '@/lib/netprobe';
import type { ScanReport } from '@/types/media';
import type { VdhApi } from '@/content/scanner';
import { mayExtensionFetch, parseUrl } from '@/lib/security';
import { withReplay } from './replay';

type ApiCall = 'scan' | 'probeHeaders' | 'fetchText' | 'sameOriginText';

/**
 * Inject the (read-only) scanner into every frame Chrome lets us into: the top frame (activeTab), same-origin
 * frames, and, where the user granted access, cross-origin and nested frames. Frames we may not enter are skipped.
 */
// By default Chrome injects into a frame only once that frame has finished loading, so one frame that never finishes (a
// player streaming over a kept-open connection, a stalled ad) held the whole scan forever. The scanner works on whatever
// the document has so far, and every call has a deadline.
const INJECT_MS = 10_000;
const SCAN_ALL_MS = 15_000;
const SCAN_TOP_MS = 10_000;
const CALL_MS = 15_000;

export async function injectScanner(tabId: number): Promise<void> {
  try {
    await withDeadline(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content.js'],
        injectImmediately: true,
      }),
      INJECT_MS,
      'injecting the scanner',
    );
  } catch (e) {
    // Some frame is stuck: the top frame alone still gives the page's own media.
    if (!(e instanceof DeadlineError)) throw e;
    await withDeadline(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['content.js'],
        injectImmediately: true,
      }),
      INJECT_MS,
      'injecting the scanner in the page',
    );
  }
}

async function callPage<T>(
  tabId: number,
  frameId: number | undefined,
  name: ApiCall,
  arg?: string,
): Promise<T> {
  const [res] = await withDeadline(
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] },
      injectImmediately: true,
      // Self-contained: serialised and run in the page's isolated world.
      func: (n: string, a?: string) => {
        const api = (globalThis as unknown as { __vdh?: Record<string, (x?: string) => unknown> }).__vdh;
        if (!api || typeof api[n] !== 'function') throw new Error('scanner-missing');
        return api[n](a);
      },
      args: arg === undefined ? [name] : [name, arg],
    }),
    CALL_MS,
    name,
  );
  return res?.result as T;
}

/** A same-origin document (feed, open-site API) read by the frame itself, anonymously (content/metadata.ts). */
export async function pageSameOriginText(
  tabId: number,
  frameId: number | undefined,
  url: string,
): Promise<string | undefined> {
  // executeScript reports a function's `undefined` as null
  const text = await callPage<unknown>(tabId, frameId, 'sameOriginText', url);
  return typeof text === 'string' ? text : undefined;
}

/** One report per frame that could be scanned; each carries the frame id it came from. */
export async function pageScanAll(tabId: number): Promise<ScanReport[]> {
  const run = (target: chrome.scripting.InjectionTarget) =>
    chrome.scripting.executeScript({
      target,
      injectImmediately: true,
      func: () => {
        const api = (globalThis as unknown as { __vdh?: { scan?: () => unknown; scanAsync?: () => unknown } })
          .__vdh;
        // scanAsync also reads the blob: sources the page holds; both return a scan report
        return api?.scanAsync ? api.scanAsync() : api?.scan ? api.scan() : null;
      },
    });
  let results: Awaited<ReturnType<typeof run>>;
  try {
    results = await withDeadline(run({ tabId, allFrames: true }), SCAN_ALL_MS, 'scanning every frame');
  } catch (e) {
    if (!(e instanceof DeadlineError)) throw e;
    results = await withDeadline(run({ tabId, frameIds: [0] }), SCAN_TOP_MS, 'scanning the page');
  }
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
      injectImmediately: true,
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

export interface CaptureLabels {
  title: string;
  cancel: string;
  progress: string;
}

export type CaptureOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * Start the MediaSource capture in the owning frame and wait until it has finished (or failed). The page controller
 * shows the banner, plays the video through and streams what the player receives to the offscreen document.
 */
export async function runCapture(
  tabId: number,
  frameId: number,
  jobId: string,
  handle: string,
  speed: 'fast' | 'realtime',
  labels: CaptureLabels,
): Promise<CaptureOutcome> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      func: (j: string, h: string, s: 'fast' | 'realtime', l: CaptureLabels) => {
        const api = (
          globalThis as unknown as {
            __vdh?: { startCapture?: (...a: unknown[]) => Promise<unknown> };
          }
        ).__vdh;
        return api?.startCapture
          ? api.startCapture(j, h, s, l)
          : { ok: false, code: 'no-source', message: 'The page scanner is not available' };
      },
      args: [jobId, handle, speed, labels],
    });
    const r = res?.result as { ok?: boolean; code?: string; message?: string } | undefined;
    return r?.ok
      ? { ok: true }
      : { ok: false, code: r?.code ?? 'failed', message: r?.message ?? 'The capture could not be completed' };
  } catch {
    return { ok: false, code: 'no-source', message: 'The page is no longer available' };
  }
}

/** Ask a running capture to stop (the job was cancelled). Best effort. */
export async function stopCapture(tabId: number, frameId: number, jobId: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      func: (j: string) => {
        const api = (globalThis as unknown as { __vdh?: { stopCapture?: (a: string) => unknown } }).__vdh;
        api?.stopCapture?.(j);
      },
      args: [jobId],
    });
  } catch {
    // the page is gone: so is the capture
  }
}

export interface RecordLabels extends CaptureLabels {
  stop: string;
}

/**
 * Start recording a MediaStream in the owning frame and wait until the recording has ended (Stop, a limit, the end of
 * the stream, or an error). The page controller shows the banner and streams the recorder's output to the offscreen document.
 */
export async function runRecord(
  tabId: number,
  frameId: number,
  jobId: string,
  handle: string,
  options: { prefer: 'webm' | 'mp4'; maxSeconds: number; maxBytes: number },
  labels: RecordLabels,
): Promise<CaptureOutcome> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      func: (j: string, h: string, o: typeof options, l: RecordLabels) => {
        const api = (
          globalThis as unknown as {
            __vdh?: { startRecord?: (...a: unknown[]) => Promise<unknown> };
          }
        ).__vdh;
        return api?.startRecord
          ? api.startRecord(j, h, o, l)
          : { ok: false, code: 'no-source', message: 'The page scanner is not available' };
      },
      args: [jobId, handle, options, labels],
    });
    const r = res?.result as { ok?: boolean; code?: string; message?: string } | undefined;
    return r?.ok
      ? { ok: true }
      : {
          ok: false,
          code: r?.code ?? 'failed',
          message: r?.message ?? 'The recording could not be completed',
        };
  } catch {
    return { ok: false, code: 'no-source', message: 'The page is no longer available' };
  }
}

/** The user pressed Stop in the queue: the recording in the page ends and hands over what it has. Best effort. */
export async function finishRecordingInPage(tabId: number, frameId: number, jobId: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      func: (j: string) => {
        const api = (globalThis as unknown as { __vdh?: { finishRecording?: (a: string) => unknown } }).__vdh;
        api?.finishRecording?.(j);
      },
      args: [jobId],
    });
  } catch {
    // the page is gone: the offscreen document saves what it received when the connection closed
  }
}
