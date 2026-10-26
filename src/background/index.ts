import { registerHandlers } from '@/lib/messaging';
import { SETTINGS_KEY, loadSettings } from '@/lib/settings';
import { isSafeFetchUrl, log } from '@/lib/security';
import type { OffscreenEvent } from '@/types/messages';
import { inspectVariant, scanTab } from './detect';
import { listJobs } from './jobStore';
import { hasHostAccess } from './pageFetch';
import { setObserverEnabled } from './observer';
import { clearHistory, handleOffscreenEvent, jobAction, reconcile, submit, syncById } from './runner';
import { clearTabState, getTabState } from './tabState';

registerHandlers({
  scan: async ({ tabId }) => ({ ok: true, state: await scanTab(tabId) }),
  'get-state': async ({ tabId }) => ({ ok: true, state: await getTabState(tabId) }),
  'inspect-variant': async ({ tabId, url }) => {
    try {
      return { ok: true, inspection: await inspectVariant(tabId, url) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'inspect-failed' };
    }
  },
  'start-download': async ({ request }) => submit(request),
  'job-action': async ({ jobId, action }) => jobAction(jobId, action),
  'clear-history': async () => {
    await clearHistory();
    return { ok: true };
  },
  'get-jobs': async () => ({ ok: true, jobs: await listJobs() }),
  'set-observer': async ({ enabled }) => {
    const active = setObserverEnabled(enabled);
    return enabled && !active ? { ok: false, error: 'no-permission' } : { ok: true };
  },
});

// Events from the offscreen document (segment downloader / FFmpeg).
chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  const ev = raw as Partial<OffscreenEvent> | null;
  if (!ev || ev.channel !== 'vdown-offscreen-event' || sender.id !== chrome.runtime.id) return false;
  void handleOffscreenEvent(ev as OffscreenEvent).catch((e: unknown) =>
    log.error('offscreen event failed:', e),
  );
  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused || delta.error) void syncById(delta.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    void clearTabState(tabId);
    void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  }
  if (changeInfo.status === 'complete' && tab.url && isSafeFetchUrl(tab.url)) {
    void (async () => {
      const settings = await loadSettings();
      if (settings.autoScan && (await hasHostAccess(tab.url ?? ''))) {
        await new Promise((r) => setTimeout(r, 1500)); // let players attach their sources
        await scanTab(tabId, true);
      }
    })().catch((e: unknown) => log.warn('auto-scan failed:', e));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void clearTabState(tabId));

async function syncObserver(): Promise<void> {
  const s = await loadSettings();
  setObserverEnabled(s.networkObserver);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) void syncObserver();
});
chrome.permissions.onAdded.addListener(() => void syncObserver());
chrome.permissions.onRemoved.addListener(() => void syncObserver());

chrome.runtime.onInstalled.addListener(() => void reconcile());
chrome.runtime.onStartup.addListener(() => void reconcile());

// Runs on every service-worker start (listeners above must be registered synchronously at top level).
void syncObserver();
void reconcile();
