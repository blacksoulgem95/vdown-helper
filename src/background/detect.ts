import { analyzeCandidates, provisionalResources, type AnalyzeContext } from '@/lib/analyze';
import {
  hookCandidates,
  markMseResources,
  markProtectedFrames,
  mseMissingReason,
  protectedKeySystems,
  type MseMissing,
} from '@/lib/hookData';
import { inspectDashRepresentation, inspectMediaPlaylist } from '@/lib/inspect';
import { parseHls } from '@/lib/hls/parser';
import { parseDash, mainPeriodIndex } from '@/lib/dash/parser';
import { parseDashRef } from '@/lib/dash/ref';
import { isSafeFetchUrl, log } from '@/lib/security';
import { loadSettings } from '@/lib/settings';
import { tabOf } from '@/lib/tabs';
import type { VariantInspection, TabState } from '@/types/messages';
import type { MediaResource, RawCandidate, ScanNotes, ScanReport } from '@/types/media';
import { readHookReports } from './hooks';
import { getManual } from './manual';
import { getObserved, isObserving } from './observer';
import { combinedFetcher, hasHostAccess, injectScanner, pageScanAll } from './pageFetch';
import { emptyState, getTabState, setTabState } from './tabState';

const inFlight = new Map<number, Promise<TabState>>();

function rank(r: MediaResource): number {
  const order = {
    'hls-master': 0,
    dash: 0,
    'hls-media': 1,
    file: 2,
    blob: 3,
    'unsupported-playlist': 4,
    subtitle: 5,
    image: 6,
    document: 6,
    archive: 6,
    asset: 7,
  } as const;
  return order[r.kind] + (r.downloadability.status === 'downloadable' ? 0 : 10);
}

export function sortResources(list: MediaResource[]): MediaResource[] {
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.height ?? 0) - (a.height ?? 0));
}

async function updateBadge(tabId: number, state: TabState): Promise<void> {
  // The badge counts what the extension is for (video, audio, subtitles); images and files have their own tabs.
  const n = state.resources.filter(
    (r) => r.downloadability.status === 'downloadable' && ['video', 'audio', 'subtitles'].includes(tabOf(r)),
  ).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00F5FF' });
    await chrome.action.setBadgeTextColor?.({ tabId, color: '#080A12' });
    await chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 99)) : '' });
  } catch {
    // The tab may have closed.
  }
}

/**
 * Combine per-frame notes. A frame origin only counts as "blocked" when none of the scanned frames lives there
 * (with access granted, an iframe that was reported unreadable by its parent has its own report).
 */
export function mergeNotes(reports: ScanReport[]): ScanNotes {
  const scanned = new Set<string>();
  for (const r of reports) {
    try {
      scanned.add(new URL(r.pageUrl).origin);
    } catch {
      // about:blank / srcdoc frames have no usable origin
    }
  }
  const blocked = new Set<string>();
  for (const r of reports)
    for (const o of r.notes.blockedFrameOrigins ?? []) if (!scanned.has(o)) blocked.add(o);
  return {
    blobSources: reports.reduce((n, r) => n + r.notes.blobSources, 0),
    inaccessibleFrames: reports.reduce((n, r) => n + r.notes.inaccessibleFrames, 0),
    blockedFrameOrigins: [...blocked].slice(0, 20),
  };
}

async function runScan(tabId: number, automatic: boolean): Promise<TabState> {
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
    const reports = await pageScanAll(tabId);
    const report = reports.find((r) => r.frameId === 0) ?? reports[0];
    if (!report) throw new Error('scanner-missing');
    const observed = await getObserved(tabId);
    const framed = reports.flatMap((r) =>
      r.candidates.map((c) => ({
        ...c,
        ...(r.frameId !== undefined ? { frameId: r.frameId } : {}),
        frameUrl: r.pageUrl,
      })),
    );
    // What the opt-in page hook saw in each frame (manifests loaded from script, key systems requested).
    const hookReports = await readHookReports(tabId);
    const frameUrls = new Map(
      reports.flatMap((r) => (r.frameId !== undefined ? [[r.frameId, r.pageUrl] as const] : [])),
    );
    const hooked = hookReports.flatMap((h) =>
      hookCandidates(h.report, {
        frameId: h.frameId,
        ...(frameUrls.get(h.frameId) ? { frameUrl: frameUrls.get(h.frameId) as string } : {}),
      }),
    );
    const protectedFrames = new Map<number, string[]>();
    for (const h of hookReports) {
      const bad = protectedKeySystems(h.report.emeKeySystems);
      if (bad.length > 0) protectedFrames.set(h.frameId, bad);
    }
    const candidates: RawCandidate[] = [...framed, ...hooked, ...observed, ...(await getManual(tabId))];
    const notes = mergeNotes(reports);
    const ctx: AnalyzeContext = {
      tabId,
      pageUrl: report.pageUrl,
      pageTitle: report.pageTitle,
      now: Date.now(),
    };

    // Publish what the page itself reveals straight away; probing fills in the details afterwards.
    const provisional = sortResources(provisionalResources(candidates, ctx));
    await setTabState({
      ...base,
      pageUrl: report.pageUrl,
      pageTitle: report.pageTitle,
      notes,
      resources: provisional,
    });

    const analysed = await analyzeCandidates(
      candidates,
      ctx,
      combinedFetcher(tabId, report.pageUrl, !automatic, frameUrls as ReadonlyMap<number, string>),
    );
    const reportsByFrame = new Map(hookReports.map((h) => [h.frameId, h.report] as const));
    const missing = await whyNoHook(analysed, reportsByFrame, frameUrls, report.pageUrl);
    const resources = sortResources(
      markProtectedFrames(markMseResources(analysed, reportsByFrame, missing), protectedFrames),
    );
    const done: TabState = {
      ...base,
      status: 'ready',
      pageUrl: report.pageUrl,
      pageTitle: report.pageTitle,
      scannedAt: Date.now(),
      notes,
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
    const code = /chrome:\/\/|chrome-extension:\/\/|extensions gallery|chrome web store|webstore/i.test(
      message,
    )
      ? 'unsupported-page'
      : /cannot access|permission|missing host/i.test(message)
        ? 'no-access'
        : 'scan-failed';
    const s: TabState = { ...base, status: 'error', error: code };
    await setTabState(s);
    return s;
  }
}

/** Scan again after the inputs changed (a pasted link): a scan already running may have started without them. */
export async function rescanTab(tabId: number): Promise<TabState> {
  await inFlight.get(tabId)?.catch(() => undefined);
  return scanTab(tabId);
}

/** Scan a tab. Concurrent requests for the same tab share one scan. */
export function scanTab(tabId: number, automatic = false): Promise<TabState> {
  const running = inFlight.get(tabId);
  if (running) return running;
  const p = runScan(tabId, automatic).finally(() => inFlight.delete(tabId));
  inFlight.set(tabId, p);
  return p;
}

/** Fetch and summarise one HLS media playlist (a chosen variant or audio rendition) for the Studio. */
export async function inspectVariant(
  tabId: number,
  url: string,
  frameId?: number,
): Promise<VariantInspection> {
  if (!isSafeFetchUrl(url)) throw new Error('unsafe-url');
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const state = await getTabState(tabId);
  const frameUrls = new Map(
    (state?.resources ?? []).flatMap((r) =>
      r.frameId !== undefined && r.frameUrl ? [[r.frameId, r.frameUrl] as const] : [],
    ),
  );
  const dashRef = parseDashRef(url);
  const res = await combinedFetcher(tabId, tab?.url ?? '', true, frameUrls).text(
    dashRef?.manifestUrl ?? url,
    frameId,
  );
  if (!res.ok) throw new Error(res.kind === 'http' ? `http-${res.status ?? 0}` : 'blocked');
  if (dashRef) {
    const d = parseDash(res.text ?? '', res.finalUrl || dashRef.manifestUrl);
    if (!d.ok) throw new Error(`parse-${d.error.code}`);
    const period = d.manifest.periods[mainPeriodIndex(d.manifest)];
    const rep = period?.representations.find((r) => r.id === dashRef.repId);
    if (!period || !rep) throw new Error('parse-no-representation');
    return inspectDashRepresentation(d.manifest, period, rep);
  }
  const parsed = parseHls(res.text ?? '', res.finalUrl || url);
  if (!parsed.ok) throw new Error(`parse-${parsed.error.code}`);
  if (parsed.playlist.kind !== 'hls-media') throw new Error('parse-not-media');
  return inspectMediaPlaylist(parsed.playlist);
}

/**
 * For each frame with a MediaSource player the page hook did not report on, why not: the setting is off, the site is
 * not allowed (so the hook is not registered there), or the player started before the hook was in place.
 */
async function whyNoHook(
  resources: readonly MediaResource[],
  reports: ReadonlyMap<number, unknown>,
  frameUrls: ReadonlyMap<number, string>,
  pageUrl: string,
): Promise<Map<number, MseMissing>> {
  const frames = new Set(
    resources
      .filter((r) => r.held?.kind === 'mse' && !reports.has(r.frameId ?? 0))
      .map((r) => r.frameId ?? 0),
  );
  const out = new Map<number, MseMissing>();
  if (frames.size === 0) return out;
  const { pageHook } = await loadSettings();
  for (const id of frames)
    out.set(id, mseMissingReason(pageHook, await hasHostAccess(frameUrls.get(id) ?? pageUrl)));
  return out;
}
