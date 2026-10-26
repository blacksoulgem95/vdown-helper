import type { TabState } from '@/types/messages';

const key = (tabId: number) => `tab:${tabId}`;

export async function getTabState(tabId: number): Promise<TabState | null> {
  const stored = await chrome.storage.session.get(key(tabId));
  return (stored[key(tabId)] as TabState | undefined) ?? null;
}

/** chrome.storage.session holds 10 MB in total; one tab may use at most this much of it. */
const MAX_STATE_BYTES = 1_000_000;

export async function setTabState(state: TabState): Promise<void> {
  let next = state;
  // Drop the least relevant resources (the list is ranked best-first) until the state fits.
  while (next.resources.length > 1 && JSON.stringify(next).length > MAX_STATE_BYTES) {
    next = { ...next, resources: next.resources.slice(0, Math.floor(next.resources.length / 2)) };
  }
  await chrome.storage.session.set({ [key(state.tabId)]: next });
}

export async function clearTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove([key(tabId), `net:${tabId}`]);
}

export function emptyState(tabId: number, pageUrl = '', pageTitle = ''): TabState {
  return {
    tabId,
    status: 'idle',
    pageUrl,
    pageTitle,
    resources: [],
    notes: { blobSources: 0, inaccessibleFrames: 0, blockedFrameOrigins: [] },
    observing: false,
  };
}
