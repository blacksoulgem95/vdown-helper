import { extensionOf, formatFromMime } from '@/lib/media';
import { isSafeFetchUrl, normalizeUrl } from '@/lib/security';
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
}

function relevant(url: string, mime: string): boolean {
  const ext = extensionOf(url);
  if (SEGMENT_EXT.has(ext)) return false;
  if (formatFromMime(mime)) return true;
  return ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'mp3', 'm4a', 'wav', 'ogg', 'flac', 'm3u8', 'mpd'].includes(
    ext,
  );
}

export async function getObserved(tabId: number): Promise<RawCandidate[]> {
  const stored = await chrome.storage.session.get(key(tabId));
  const list = (stored[key(tabId)] as Observed[] | undefined) ?? [];
  return list.map((o) => ({ url: o.url, method: 'network', ...(o.mime ? { mimeType: o.mime } : {}) }));
}

async function record(tabId: number, o: Observed): Promise<void> {
  const stored = await chrome.storage.session.get(key(tabId));
  const list = (stored[key(tabId)] as Observed[] | undefined) ?? [];
  const k = normalizeUrl(o.url);
  if (list.some((x) => normalizeUrl(x.url) === k)) return;
  list.push(o);
  await chrome.storage.session.set({ [key(tabId)]: list.slice(-MAX_PER_TAB) });
}

type HeadersListener = Parameters<typeof chrome.webRequest.onHeadersReceived.addListener>[0];

const listener: HeadersListener = (d) => {
  if (d.tabId < 0 || !isSafeFetchUrl(d.url)) return undefined;
  const ct = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  if (relevant(d.url, ct)) {
    const o: Observed = ct ? { url: d.url, mime: ct.split(';')[0]?.trim() ?? '' } : { url: d.url };
    void record(d.tabId, o);
  }
  return undefined;
};

/**
 * Start or stop observing. Returns whether the observer is now active. Starting requires the optional
 * `webRequest` permission; without it this is a no-op that returns false.
 */
export function setObserverEnabled(enabled: boolean): boolean {
  const api = chrome.webRequest?.onHeadersReceived;
  if (!api) return false;
  if (enabled && !registered) {
    api.addListener(listener, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, [
      'responseHeaders',
    ]);
    registered = true;
  } else if (!enabled && registered) {
    api.removeListener(listener);
    registered = false;
  }
  return registered;
}

export function isObserving(): boolean {
  return registered;
}
