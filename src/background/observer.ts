import { extensionOf, formatFromMime } from '@/lib/media';
import { isSafeFetchUrl, normalizeUrl } from '@/lib/security';
import { loadSettings } from '@/lib/settings';
import type { RawCandidate } from '@/types/media';

/**
 * Optional network observer (webRequest, read-only: no blocking, no header modification).
 * Only active when the user has granted the optional `webRequest` + host permissions and enabled it in Settings.
 */
const key = (tabId: number) => `net:${tabId}`;
const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'aac', 'vtt', 'webvtt', 'key']);
const MAX_PER_TAB = 100;
let registered = false;

interface Observed {
  url: string;
  mime?: string;
  /** Frame that made the request (webRequest frameId): lets the player's own frame probe it. */
  frameId?: number;
}

function relevant(url: string, mime: string): boolean {
  const ext = extensionOf(url);
  if (SEGMENT_EXT.has(ext)) return false;
  if (formatFromMime(mime)) return true;
  return [
    'mp4',
    'm4v',
    'webm',
    'mkv',
    'mov',
    'mp3',
    'm4a',
    'wav',
    'ogg',
    'flac',
    'opus',
    'aiff',
    'aif',
    'wma',
    'flv',
    'avi',
    'wmv',
    'asf',
    '3gp',
    '3g2',
    'mpg',
    'mpeg',
    'm3u8',
    'mpd',
    'vtt',
    'srt',
    'ttml',
    'dfxp',
  ].includes(ext);
}

export async function getObserved(tabId: number): Promise<RawCandidate[]> {
  const stored = await chrome.storage.session.get(key(tabId));
  const list = (stored[key(tabId)] as Observed[] | undefined) ?? [];
  return list.map((o) => ({
    url: o.url,
    method: 'network' as const,
    ...(o.mime ? { mimeType: o.mime } : {}),
    ...(o.frameId !== undefined && o.frameId >= 0 ? { frameId: o.frameId } : {}),
  }));
}

let writes: Promise<unknown> = Promise.resolve();

/**
 * Remember one request. Writes run one after another: a player asks for its master playlist and the variants within
 * milliseconds, and overlapping read-modify-writes of the same list used to drop some of them (often the master).
 */
function record(tabId: number, o: Observed): Promise<void> {
  const run = writes.then(async () => {
    const stored = await chrome.storage.session.get(key(tabId));
    const list = (stored[key(tabId)] as Observed[] | undefined) ?? [];
    const k = normalizeUrl(o.url);
    if (list.some((x) => normalizeUrl(x.url) === k)) return;
    list.push(o);
    await chrome.storage.session.set({ [key(tabId)]: list.slice(-MAX_PER_TAB) });
  });
  writes = run.catch(() => undefined);
  return run;
}

type HeadersListener = Parameters<typeof chrome.webRequest.onHeadersReceived.addListener>[0];

/** Whether the user wants the observer; undefined until the settings have been read on this worker start. */
let wanted: boolean | undefined;

const listener: HeadersListener = (d) => {
  if (d.tabId < 0 || !isSafeFetchUrl(d.url)) return undefined;
  const ct = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  if (!relevant(d.url, ct)) return undefined;
  const o: Observed = ct
    ? { url: d.url, mime: ct.split(';')[0]?.trim() ?? '', frameId: d.frameId }
    : { url: d.url, frameId: d.frameId };
  void (async () => {
    // The request that woke the worker arrives before the settings are read: read them, then decide.
    if (wanted === undefined) wanted = (await loadSettings()).networkObserver;
    if (wanted) await record(d.tabId, o);
  })().catch(() => undefined);
  return undefined;
};

const FILTER: chrome.webRequest.RequestFilter = {
  urls: ['<all_urls>'],
  types: ['media', 'xmlhttprequest', 'other'],
};

function attach(): boolean {
  const api = chrome.webRequest?.onHeadersReceived;
  if (!api) return false;
  if (!registered) {
    api.addListener(listener, FILTER, ['responseHeaders']);
    registered = true;
  }
  return true;
}

/**
 * Called synchronously at the top level of the service worker. A listener added later (after an await) is not one
 * Chrome wakes a sleeping worker for, so requests made while the worker slept were never seen. The optional
 * `webRequest` permission is held only while the observer is on (Settings removes it when it is switched off), so
 * this listener exists only then.
 */
export function initObserver(): void {
  attach();
}

/**
 * Start or stop observing. Returns whether the observer is now active. Starting requires the optional
 * `webRequest` permission; without it this is a no-op that returns false.
 */
export function setObserverEnabled(enabled: boolean): boolean {
  wanted = enabled;
  if (enabled) return attach();
  const api = chrome.webRequest?.onHeadersReceived;
  if (api && registered) api.removeListener(listener);
  registered = false;
  return false;
}

export function isObserving(): boolean {
  return registered && wanted === true;
}
