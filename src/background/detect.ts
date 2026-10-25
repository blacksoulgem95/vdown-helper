import { analyzeCandidates, provisionalResources, type AnalyzeContext } from '@/lib/analyze';
import { inspectMediaPlaylist } from '@/lib/inspect';
import { parseHls } from '@/lib/hls/parser';
import { isSafeFetchUrl, log } from '@/lib/security';
import type { VariantInspection, TabState } from '@/types/messages';
import type { MediaResource, RawCandidate } from '@/types/media';
import { getObserved, isObserving } from './observer';
import { combinedFetcher, injectScanner, pageScan } from './pageFetch';
import { emptyState, getTabState, setTabState } from './tabState';

const inFlight = new Map<number, Promise<TabState>>();

function rank(r: MediaResource): number {
  const order = { 'hls-master': 0, 'hls-media': 1, file: 2, blob: 3, 'unsupported-playlist': 4 } as const;
  return (order[r.kind] ?? 5) + (r.downloadability.status === 'downloadable' ? 0 : 10);
}

export function sortResources(list: MediaResource[]): MediaResource[] {
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.height ?? 0) - (a.height ?? 0));
}

async function updateBadge(tabId: number, state: TabState): Promise<void> {
  const n = state.resources.filter((r) => r.downloadability.status === 'downloadable').length;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00F5FF' });
    await chrome.action.setBadgeTextColor?.({ tabId, color: '#080A12' });
    await chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 99)) : '' });
  } catch {
    // The tab may have closed.
  }
}

async function runScan(tabId: number): Promise<TabState> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ...emptyState(tabId), status: 'error', error: 'tab-closed' };
  }
  const previous = await getTabState(tabId);
  const pageUrl = tab.url ?? previous?.pageUrl ?? '';
  const base: TabState = {
    ...(previous ?? emptyState(tabId)),
    tabId,
    status: 'scanning',
    pageUrl,
    pageTitle: tab.title ?? '',
    observing: isObserving(),
  };
  delete base.error;
  await setTabState(base);

  // chrome://, the Web Store, file:// and similar pages cannot (and must not) be scanned.
  if (pageUrl && !isSafeFetchUrl(pageUrl)) {
    const s: TabState = { ...base, status: 'error', error: 'unsupported-page', resources: [] };
    await setTabState(s);
    return s;
  }

  try {
    await injectScanner(tabId);
    const report = await pageScan(tabId);
    const observed = await getObserved(tabId);
    const candidates: RawCandidate[] = [...report.candidates, ...observed];
    const ctx: AnalyzeContext = { tabId, pageUrl: report.pageUrl, pageTitle: report.pageTitle, now: Date.now() };

    // Publish what the page itself reveals straight away; probing fills in the details afterwards.
    const provisional = sortResources(provisionalResources(candidates, ctx));
    await setTabState({ ...base, pageUrl: report.pageUrl, pageTitle: report.pageTitle, notes: report.notes, resources: provisional });

    const resources = sortResources(await analyzeCandidates(candidates, ctx, combinedFetcher(tabId)));
    const done: TabState = {
      ...base,
      status: 'ready',
      pageUrl: report.pageUrl,
      pageTitle: report.pageTitle,
      scannedAt: Date.now(),
      notes: report.notes,
      resources,
      observing: isObserving(),
    };
    await setTabState(done);
    await updateBadge(tabId, done);
    return done;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'scan-failed';
    log.warn('scan failed:', message);
    // Without activeTab/host access Chrome refuses the injection with a "Cannot access" message.
    const code = /cannot access|extensions gallery|permission|missing host/i.test(message) ? 'no-access' : 'scan-failed';
    const s: TabState = { ...base, status: 'error', error: code };
    await setTabState(s);
    return s;
  }
}

/** Scan a tab. Concurrent requests for the same tab share one scan. */
export function scanTab(tabId: number): Promise<TabState> {
  const running = inFlight.get(tabId);
  if (running) return running;
  const p = runScan(tabId).finally(() => inFlight.delete(tabId));
  inFlight.set(tabId, p);
  return p;
}

/** Fetch and summarise one HLS media playlist (a chosen variant or audio rendition) for the Studio. */
export async function inspectVariant(tabId: number, url: string): Promise<VariantInspection> {
  if (!isSafeFetchUrl(url)) throw new Error('unsafe-url');
  const res = await combinedFetcher(tabId).text(url);
  if (!res.ok) throw new Error(res.kind === 'http' ? `http-${res.status ?? 0}` : 'blocked');
  const parsed = parseHls(res.text ?? '', res.finalUrl || url);
  if (!parsed.ok) throw new Error(`parse-${parsed.error.code}`);
  if (parsed.playlist.kind !== 'hls-media') throw new Error('parse-not-media');
  return inspectMediaPlaylist(parsed.playlist);
}
