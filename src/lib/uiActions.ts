import type { DownloadJob } from '@/types/download';
import type { VariantInspection } from '@/types/messages';
import type { MediaResource } from '@/types/media';
import type { Settings } from '@/types/settings';
import { t } from './i18n';
import { originsOf, sampleByOrigin } from './inspect';
import { probeHeaders } from './netprobe';
import { send } from './messaging';
import {
  audioOptions,
  buildRequest,
  buildCaptureRequest,
  buildLiveRequest,
  buildRecordRequest,
  buildZipRequest,
  defaultChoices,
  planFromRequest,
  type Choices,
} from './request';
import { planZip } from './zip';
import { mayExtensionFetch, parseUrl } from './security';

export type StartOutcome = { ok: true; jobId: string } | { ok: false; error: string; needsAccess?: string[] };

const originPatterns = (origins: string[]) => origins.map((o) => `${o}/*`);

export async function hasAccess(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  try {
    return await chrome.permissions.contains({ origins: originPatterns(origins) });
  } catch {
    return false;
  }
}

/**
 * Ask the user for access to specific sites. Must be called from a user gesture. (All sites: `requestAllSites`.)
 * Needed because downloading segments happens from the extension, whose requests are subject to CORS unless
 * the user has granted the site.
 */
export async function requestAccess(origins: string[]): Promise<boolean> {
  if (origins.length === 0 || (await hasAccess(origins))) return true;
  try {
    // The second permission lets downloads replay the owning frame's Referer/Origin; it is optional and harmless alone.
    return await chrome.permissions.request({
      origins: originPatterns(origins),
      permissions: ['declarativeNetRequestWithHostAccess'],
    });
  } catch {
    return false;
  }
}

/** Access to every site, with the header-replay permission: what unlocks every embedded player, nested to any depth. */
export const ALL_SITES_ACCESS: chrome.permissions.Permissions = {
  origins: ['<all_urls>'],
  permissions: ['declarativeNetRequestWithHostAccess'],
};

/** Ask once for access to all sites. Must be called from a user gesture; afterwards no frame needs asking for again. */
export async function requestAllSites(): Promise<boolean> {
  try {
    return await chrome.permissions.request(ALL_SITES_ACCESS);
  } catch {
    return false;
  }
}

export const originOf = (url: string): string | undefined => parseUrl(url)?.origin;

/** Human text for the machine-readable errors returned by the background. */
export function describeError(raw: string): string {
  if (raw === 'unsafe-url') return t('errUnsafeUrl');
  if (raw === 'protected') return t('errProtected');
  if (raw === 'no-permission') return t('errNoPermission');
  if (raw === 'nothing-to-zip') return t('errNothingToZip');
  if (raw.startsWith('plan:')) {
    const issues = raw.slice(5).split(',').filter(Boolean);
    return issues.map((i) => issueText(i)).join(' ');
  }
  if (
    raw.startsWith('inspect:') ||
    raw.startsWith('http-') ||
    raw === 'blocked' ||
    raw.startsWith('parse-')
  ) {
    const code = raw.replace(/^inspect:/, '');
    if (code === 'blocked') return t('errBlocked');
    if (code.startsWith('http-')) return t('errHttp', code.slice(5));
    if (code === 'parse-dash') return t('reasonDash');
    return t('errParse');
  }
  return t('errGeneric');
}

export function issueText(issue: string): string {
  switch (issue) {
    case 'no-audio-source':
      return t('issueNoAudio');
    case 'no-video-source':
      return t('issueNoVideo');
    case 'video-codec-container':
      return t('issueVideoCodec');
    case 'audio-codec-container':
      return t('issueAudioCodec');
    case 'too-large':
      return t('issueTooLarge');
    case 'too-long-to-encode':
      return t('issueTooLong');
    case 'protected':
      return t('errProtected');
    case 'live-stream':
      return t('issueLive');
    case 'unsupported-source':
      return t('issueUnsupported');
    default:
      return t('errGeneric');
  }
}

export interface Inspections {
  video?: VariantInspection;
  audio?: VariantInspection;
}

/** Inspect the media playlists a request would use. Retries once after asking for access to a blocked site. */
export async function inspectForChoices(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
  allowPrompt: boolean,
): Promise<{ ok: true; inspections: Inspections } | { ok: false; error: string }> {
  const draft = buildRequest(resource, settings, choices);
  if (!draft.isHls && !draft.isDash) return { ok: true, inspections: {} };
  const out: Inspections = {};
  for (const [slot, url] of [
    ['video', draft.sourceUrl],
    ['audio', draft.audioUrl],
  ] as const) {
    if (!url) continue;
    let r = await send('inspect-variant', {
      tabId: resource.tabId,
      url,
      ...(resource.frameId !== undefined ? { frameId: resource.frameId } : {}),
    });
    if (!r.ok && r.error === 'blocked' && allowPrompt) {
      const origin = originOf(url);
      if (origin && (await requestAccess([origin])))
        r = await send('inspect-variant', {
          tabId: resource.tabId,
          url,
          ...(resource.frameId !== undefined ? { frameId: resource.frameId } : {}),
        });
    }
    if (!r.ok) return { ok: false, error: `inspect:${r.error}` };
    out[slot] = r.inspection;
  }
  return { ok: true, inspections: out };
}

export function originsFor(inspections: Inspections): string[] {
  return originsOf([...(inspections.video?.origins ?? []), ...(inspections.audio?.origins ?? [])]);
}

/**
 * Origins the extension still cannot read. A site that already allows cross-origin reads (typical CDNs send
 * `Access-Control-Allow-Origin: *`) needs no permission prompt, so each missing origin is probed first.
 */
export async function originsNeedingAccess(inspections: Inspections, pageUrl: string): Promise<string[]> {
  const samples = {
    ...(inspections.audio?.originSamples ?? {}),
    ...(inspections.video?.originSamples ?? {}),
  };
  const missing: string[] = [];
  for (const origin of originsFor(inspections)) {
    if (await hasAccess([origin])) continue;
    const sample = samples[origin];
    // Never probe private-network targets on a page's say-so.
    const probe =
      sample && mayExtensionFetch(sample, pageUrl) ? await probeHeaders(sample, fetch, 'omit') : undefined;
    // Any HTTP response (even 4xx) means the request was readable; only a blocked fetch needs permission.
    if (!probe || (!probe.ok && probe.kind !== 'http')) missing.push(origin);
  }
  return missing;
}

/**
 * Build, check access for, and queue a download. Call from a click handler: it may show a permission prompt.
 */
export async function startFromChoices(
  resource: MediaResource,
  settings: Settings,
  choices: Choices,
  known?: Inspections,
): Promise<StartOutcome> {
  const insp = known ?? (await inspectForChoices(resource, settings, choices, true));
  if ('ok' in insp && insp.ok === false) return { ok: false, error: describeError(insp.error) };
  const inspections: Inspections = 'inspections' in insp ? insp.inspections : (insp as Inspections);

  const missing = await originsNeedingAccess(inspections, resource.pageUrl);
  if (missing.length > 0 && !(await requestAccess(missing))) {
    return { ok: false, error: t('errAccessDenied'), needsAccess: missing };
  }
  const request = buildRequest(resource, settings, choices, inspections.video);
  // Cookies only for the page's own origin; other hosts the playlist names are fetched anonymously.
  request.credentialedOrigins = originOf(resource.pageUrl) ? [originOf(resource.pageUrl) as string] : [];
  // Merge the audio inspection's live/DRM facts conservatively.
  if (inspections.audio?.live) request.live = true;
  if (inspections.audio?.protectedByDrm) return { ok: false, error: t('errProtected') };
  const res = await send('start-download', { request });
  return res.ok ? { ok: true, jobId: res.jobId } : { ok: false, error: describeError(res.error) };
}

/** One-click download with the user's defaults. */
export async function quickDownload(resource: MediaResource, settings: Settings): Promise<StartOutcome> {
  return startFromChoices(resource, settings, defaultChoices(resource, settings));
}

export { audioOptions };

/**
 * Open or reveal a finished download. `downloads.open()` requires a user gesture, which only exists in the page
 * that received the click, so this runs in the popup / side panel rather than in the service worker.
 */
export async function openDownloadedFile(
  job: Pick<DownloadJob, 'chromeDownloadId' | 'stage'>,
  action: 'open' | 'show',
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (job.stage !== 'completed' || job.chromeDownloadId === undefined)
    return { ok: false, error: t('errFileUnavailable') };
  try {
    const [item] = await chrome.downloads.search({ id: job.chromeDownloadId });
    if (!item || !item.exists) return { ok: false, error: t('errFileMissing') };
    if (action === 'open') await chrome.downloads.open(job.chromeDownloadId);
    else chrome.downloads.show(job.chromeDownloadId);
    return { ok: true };
  } catch {
    return { ok: false, error: t('errFileMissing') };
  }
}

/** Pack the selected plain files into one ZIP. Asks for access to the sites the files live on (the click is the gesture). */
export async function startZip(resources: MediaResource[], settings: Settings): Promise<StartOutcome> {
  const { items } = planZip(resources);
  if (items.length === 0) return { ok: false, error: t('errNothingToZip') };
  const request = buildZipRequest(resources, settings);
  const plan = planFromRequest(request, {
    maxMemoryMb: settings.maxMemoryMb,
    maxEncodeDurationSec: settings.maxEncodeDurationSec,
  });
  if (!plan.valid) return { ok: false, error: t('zipTooLarge') };
  const urls = items.map((i) => i.url);
  const probe: Inspections = {
    video: {
      url: request.pageUrl,
      segmentCount: 0,
      durationSec: 0,
      live: false,
      fragmented: false,
      encryption: [],
      protectedByDrm: false,
      keyUris: [],
      origins: originsOf(urls),
      originSamples: sampleByOrigin(urls),
      firstSegmentExt: '',
    },
  };
  const missing = await originsNeedingAccess(probe, request.pageUrl);
  if (missing.length > 0 && !(await requestAccess(missing))) {
    return { ok: false, error: t('errAccessDenied'), needsAccess: missing };
  }
  const res = await send('start-download', { request });
  return res.ok ? { ok: true, jobId: res.jobId } : { ok: false, error: describeError(res.error) };
}

/** Capture a MediaSource video. The click on the button is the user's decision to let the page play it through. */
export async function startCapture(
  resource: MediaResource,
  settings: Settings,
  speed: 'fast' | 'realtime',
): Promise<StartOutcome> {
  const request = buildCaptureRequest(resource, settings, speed);
  const res = await send('start-download', { request });
  return res.ok ? { ok: true, jobId: res.jobId } : { ok: false, error: describeError(res.error) };
}

/** Record a live stream (HLS, DASH dynamic), or a MediaStream the page plays, until Stop. */
export async function startRecord(resource: MediaResource, settings: Settings): Promise<StartOutcome> {
  const request =
    resource.held?.kind === 'stream'
      ? buildRecordRequest(resource, settings)
      : buildLiveRequest(resource, settings);
  const res = await send('start-download', { request });
  return res.ok ? { ok: true, jobId: res.jobId } : { ok: false, error: describeError(res.error) };
}
