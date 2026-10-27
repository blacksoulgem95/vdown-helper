import { isSafeFetchUrl, normalizeUrl } from '@/lib/security';
import type { RawCandidate } from '@/types/media';

/**
 * Stream or file links the user pasted into the popup for a tab (an .m3u8 seen in the browser's network panel, for
 * instance). They are scanned like anything the page shows, and forgotten when the tab navigates.
 */
const key = (tabId: number) => `manual:${tabId}`;
const MAX_PER_TAB = 20;
let writes: Promise<unknown> = Promise.resolve();

/** The pasted text as a link the extension may fetch (http/https only), or undefined. */
export function manualUrl(text: string): string | undefined {
  const url = text.trim();
  return isSafeFetchUrl(url) ? url : undefined;
}

export function addManual(tabId: number, url: string): Promise<void> {
  const run = writes.then(async () => {
    const stored = await chrome.storage.session.get(key(tabId));
    const list = (stored[key(tabId)] as string[] | undefined) ?? [];
    if (list.some((u) => normalizeUrl(u) === normalizeUrl(url))) return;
    await chrome.storage.session.set({ [key(tabId)]: [...list, url].slice(-MAX_PER_TAB) });
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function getManual(tabId: number): Promise<RawCandidate[]> {
  const stored = await chrome.storage.session.get(key(tabId));
  const list = (stored[key(tabId)] as string[] | undefined) ?? [];
  return list.filter((u) => isSafeFetchUrl(u)).map((url) => ({ url, method: 'manual-rescan' as const }));
}
