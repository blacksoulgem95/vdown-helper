import { registerHandlers } from '@/lib/messaging';
import { SETTINGS_KEY, loadSettings, runMigrations } from '@/lib/settings';
import { isExtensionPage, isSafeFetchUrl, log } from '@/lib/security';
import type { OffscreenEvent } from '@/types/messages';
import { forgetTab, inspectVariant, rescanTab, scanTab } from './detect';
import { sameDocument } from '@/lib/deadline';
import { desktopStatus } from './desktop';
import { addManual, manualUrl } from './manual';
import { listJobs } from './jobStore';
import { syncHook } from './hooks';
import { hasHostAccess } from './pageFetch';
import { initObserver, setObserverEnabled } from './observer';
import { clearHistory, handleOffscreenEvent, jobAction, reconcile, submit, syncById } from './runner';
import { clearTabState, getTabState } from './tabState';

registerHandlers({
  scan: async ({ tabId }) => ({ ok: true, state: await scanTab(tabId) }),
  'get-state': async ({ tabId }) => ({ ok: true, state: await getTabState(tabId) }),
  'add-url': async ({ tabId, url }) => {
    const link = manualUrl(url);
    if (!link) return { ok: false, error: 'unsafe-url' };
    await addManual(tabId, link);
    return { ok: true, state: await rescanTab(tabId) };
  },
  'inspect-variant': async ({ tabId, url, frameId }) => {
    try {
      return { ok: true, inspection: await inspectVariant(tabId, url, frameId) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'inspect-failed' };
    }
  },
  'start-download': async ({ request, desktop }) => submit(request, desktop === true),
  'job-action': async ({ jobId, action }) => jobAction(jobId, action),
  'clear-history': async () => {
    await clearHistory();
    return { ok: true };
  },
  'get-jobs': async () => ({ ok: true, jobs: await listJobs() }),
  'sync-hook': async () => ({ ok: true, registered: await syncHook() }),
  'desktop-status': async () => ({ ok: true, status: await desktopStatus() }),
  'set-observer': async ({ enabled }) => {
    const active = setObserverEnabled(enabled);
    return enabled && !active ? { ok: false, error: 'no-permission' } : { ok: true };
  },
});

// Events from the offscreen document (segment downloader / FFmpeg).
chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  const ev = raw as Partial<OffscreenEvent> | null;
  if (!ev || ev.channel !== 'vdown-offscreen-event' || !isExtensionPage(sender)) return false;
  void handleOffscreenEvent(ev as OffscreenEvent).catch((e: unknown) =>
    log.error('offscreen event failed:', e),
  );
  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused || delta.error) void syncById(delta.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A new page in the tab: forget the old one. Only a change of the top document's address counts: Chrome also reports
  // the tab as "loading" while a frame loads (a player appearing after a click), and that used to wipe the page's results,
  // the requests the network observer had seen and the links the user had added.
  if (changeInfo.url !== undefined) {
    const url = changeInfo.url;
    void (async () => {
      const previous = (await getTabState(tabId))?.pageUrl;
      if (previous !== undefined && sameDocument(previous, url)) return;
      forgetTab(tabId);
      await clearTabState(tabId);
      await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    })();
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
  await syncHook();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) void syncObserver();
});
chrome.permissions.onAdded.addListener(() => void syncObserver());
chrome.permissions.onRemoved.addListener(() => void syncObserver());

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void reconcile();
  // The settings change it makes re-syncs the page hook through storage.onChanged.
  runMigrations(reason).catch((e: unknown) =>
    log.warn('migration failed:', e instanceof Error ? e.message : 'error'),
  );
});
chrome.runtime.onStartup.addListener(() => void reconcile());

// Runs on every service-worker start (listeners above must be registered synchronously at top level).
initObserver();
void syncObserver();
void reconcile();
