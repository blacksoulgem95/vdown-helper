import type { TabState } from '@/types/messages';

const key = (tabId: number) => `tab:${tabId}`;

export async function getTabState(tabId: number): Promise<TabState | null> {
  const stored = await chrome.storage.session.get(key(tabId));
  return (stored[key(tabId)] as TabState | undefined) ?? null;
}

export async function setTabState(state: TabState): Promise<void> {
  await chrome.storage.session.set({ [key(state.tabId)]: state });
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
    notes: { blobSources: 0, inaccessibleFrames: 0 },
    observing: false,
  };
}
