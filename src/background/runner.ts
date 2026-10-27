import { planFromRequest, sanitizeRequest } from '@/lib/request';
import { loadSettings } from '@/lib/settings';
import {
  SpeedMeter,
  canRestage,
  canRetry,
  canStop,
  canTransition,
  restage,
  createJob,
  failJob,
  isActive,
  isQueued,
  isTerminal,
  retryJob,
  transition,
  withProgress,
} from '@/lib/queue';
import { asciiFileName, isOwnBlobUrl, log, mayExtensionFetch, parseUrl, withExtension } from '@/lib/security';
import type { Plan } from '@/lib/compat';
import type { DownloadJob, DownloadRequest, JobErrorCode } from '@/types/download';
import type { MediaResource } from '@/types/media';
import type { OffscreenEvent, OffscreenPlan, Result } from '@/types/messages';
import { isDataLabel } from '@/lib/dataUrl';
import { isFileKind } from '@/lib/filetypes';
import { planZip } from '@/lib/zip';
import { inspectVariant } from './detect';
import { finishRecordingInPage, pumpHeld, runCapture, runRecord, stopCapture } from './pageFetch';
import { t } from '@/lib/i18n';
import { getJob, listJobs, mutateJobs, putJob, removeJobs, updateJob } from './jobStore';
import { notifyJob } from './notify';
import { getTabState } from './tabState';
import { installReplay, pruneReplay, removeReplay } from './replay';
import {
  cancelInOffscreen,
  stopInOffscreen,
  closeOffscreen,
  offscreenAlive,
  releaseInOffscreen,
  runInOffscreen,
} from './offscreenBridge';

const meters = new Map<string, SpeedMeter>();
let polling = false;

const ok = (): Result<object> => ({ ok: true });
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * Cookies only go to the page's own origin and to the origin of the frame the player lives in. A frame on a
 * private-network host is only trusted when the top page is on one too (the SSRF guard in lib/security).
 */
export function credentialedFor(req: DownloadRequest, resource: MediaResource | undefined): string[] {
  const origins = new Set<string>();
  const pageOrigin = parseUrl(req.pageUrl)?.origin;
  if (pageOrigin) origins.add(pageOrigin);
  const frame = resource?.frameUrl ? parseUrl(resource.frameUrl) : undefined;
  if (frame && mayExtensionFetch(frame.href, req.pageUrl)) origins.add(frame.origin);
  return [...origins];
}

function chromePath(req: DownloadRequest, ascii = false): string {
  const path = req.subfolder ? `${req.subfolder}/${req.filename}` : req.filename;
  return ascii ? asciiFileName(path) : path;
}

/** chrome.downloads.download, retrying once with an ASCII-only name if Chrome rejects the file name. */
export async function startChromeDownload(url: string, req: DownloadRequest): Promise<number> {
  const options = (filename: string): chrome.downloads.DownloadOptions => ({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: req.saveAs === true,
  });
  try {
    return await chrome.downloads.download(options(chromePath(req)));
  } catch (e) {
    if (
      e instanceof Error &&
      /invalid filename/i.test(e.message) &&
      chromePath(req) !== chromePath(req, true)
    ) {
      return chrome.downloads.download(options(chromePath(req, true)));
    }
    throw e;
  }
}

function limitsOf(s: { maxMemoryMb: number; maxEncodeDurationSec: number }) {
  return { maxMemoryMb: s.maxMemoryMb, maxEncodeDurationSec: s.maxEncodeDurationSec };
}

/**
 * Validate a request received from the UI and queue it. Never trusts UI-provided names, URLs or stream facts:
 * HLS requests are re-inspected here so DRM, live streams and size limits are checked against the real playlist.
 */
export async function submit(raw: DownloadRequest): Promise<Result<{ jobId: string }>> {
  const clean = sanitizeRequest(raw);
  if (!clean) return fail('unsafe-url');
  const settings = await loadSettings();
  if (clean.zip) return submitZip(clean, settings);
  // Facts about where the media lives come from the background's own scan, never from the request.
  const resource = (await getTabState(clean.tabId))?.resources.find((r) => r.id === clean.resourceId);
  let req: DownloadRequest = { ...clean, credentialedOrigins: credentialedFor(clean, resource) };
  const involved: string[] = [];
  // Whatever the request says, a resource the scan found protected (e.g. the page uses EME) is never downloaded.
  if (resource?.downloadability.status === 'protected') return fail('protected');
  if (req.isHls || req.isDash) {
    try {
      const ins = await inspectVariant(req.tabId, req.sourceUrl, resource?.frameId);
      if (ins.protectedByDrm) return fail('protected');
      involved.push(...ins.origins);
      req = { ...req, fragmented: ins.fragmented, live: ins.live, durationSec: ins.durationSec };
      if (req.audioUrl) {
        const aud = await inspectVariant(req.tabId, req.audioUrl, resource?.frameId);
        if (aud.protectedByDrm) return fail('protected');
        involved.push(...aud.origins);
        if (aud.live) req = { ...req, live: true };
      }
    } catch (e) {
      return fail(`inspect:${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  // A live recording needs a stream that really is live (the inspection above decides, not the request).
  if (req.liveRecord && ((!req.isHls && !req.isDash) || !req.live)) return fail('not-live');
  // Capturing and recording only exist for what the page holds: anything else claiming to be one is refused.
  if ((req.capture || req.record) && !isDataLabel(req.sourceUrl)) return fail('unsafe-url');
  if (isDataLabel(req.sourceUrl)) {
    // Page-held bytes: only for a resource this background saw in its own scan of the tab.
    if (!resource?.held || resource.url !== req.sourceUrl) return fail('unsafe-url');
    // A MediaSource player is only ever captured (never "downloaded"), and only when the scan found it capturable.
    if ((resource.held.kind === 'mse') !== (req.capture !== undefined)) return fail('unsafe-url');
    // A MediaStream is only ever recorded (never "downloaded"); capture and record exclude each other.
    if ((resource.held.kind === 'stream') !== (req.record !== undefined) || (req.capture && req.record))
      return fail('unsafe-url');
    if ((req.capture || req.record) && resource.downloadability.status !== 'downloadable')
      return fail('protected');
    req = { ...req, held: { ...resource.held, frameId: resource.frameId ?? 0 } };
  } else if (resource?.frameUrl) {
    req = {
      ...req,
      replay: {
        frameUrl: resource.frameUrl,
        urls: [req.sourceUrl, ...(req.audioUrl ? [req.audioUrl] : []), ...involved],
      },
    };
  }
  const plan = planFromRequest(req, limitsOf(settings));
  if (!plan.valid) return fail(`plan:${plan.issues.join(',')}`);

  const job = createJob(crypto.randomUUID(), req, plan, Date.now());
  if (plan.pipeline !== 'native' || req.held) job.viaOffscreen = true;
  await putJob(job);
  void pump();
  return { ok: true, jobId: job.id };
}

/**
 * A ZIP of plain files. Every URL and entry name comes from this background's own scan of the tab: the request only
 * names resources, so it cannot make the extension fetch anything the page did not show it.
 */
async function submitZip(
  clean: DownloadRequest,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<Result<{ jobId: string }>> {
  const state = await getTabState(clean.tabId);
  const wanted = new Set(clean.zip?.resourceIds ?? []);
  const chosen = (state?.resources ?? []).filter((r) => wanted.has(r.id) && isFileKind(r.kind));
  const { items, left } = planZip(chosen);
  if (items.length === 0) return fail('nothing-to-zip');
  const included = chosen
    .filter((r) => !r.held && r.downloadability.status === 'downloadable')
    .slice(0, items.length);
  const origins = new Set(included.flatMap((r) => credentialedFor(clean, r)));
  const frames = new Set(included.map((r) => r.frameUrl ?? ''));
  let req: DownloadRequest = {
    ...clean,
    credentialedOrigins: [...origins],
    zip: { resourceIds: [...wanted], items, left: left + (wanted.size - chosen.length) },
    filename: withExtension(
      `${clean.filename.replace(/ \(\d+ files\)\.zip$/i, '')} (${items.length} files)`,
      'zip',
    ),
    qualityLabel: `ZIP · ${items.length}`,
  };
  const known = included.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  if (known > 0) req = { ...req, estimatedBytes: known };
  else delete req.estimatedBytes;
  const only = [...frames][0];
  // One Referer can only describe one frame: replay it when every file came from the same one.
  if (frames.size === 1 && only) req = { ...req, replay: { frameUrl: only, urls: items.map((i) => i.url) } };
  const plan = planFromRequest(req, limitsOf(settings));
  if (!plan.valid) return fail(`plan:${plan.issues.join(',')}`);
  const job = createJob(crypto.randomUUID(), req, plan, Date.now());
  job.viaOffscreen = true;
  await putJob(job);
  void pump();
  return { ok: true, jobId: job.id };
}

/** Start queued jobs while concurrency slots are free. Slots are reserved atomically in storage. */
export async function pump(): Promise<void> {
  const settings = await loadSettings();
  const now = Date.now();
  const startIds = await mutateJobs((jobs) => {
    const all = Object.values(jobs);
    const free = settings.maxConcurrentDownloads - all.filter(isActive).length;
    const queued = all
      .filter(isQueued)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, Math.max(0, free));
    for (const j of queued) jobs[j.id] = transition(j, 'preparing', now);
    return queued.map((j) => j.id);
  });
  for (const id of startIds) void runJob(id);
}

function offscreenPlan(
  plan: Plan,
  maxMemoryMb: number,
  segmentConcurrency: number,
  record: { mb: number; minutes: number },
): OffscreenPlan {
  return {
    pipeline: plan.pipeline as OffscreenPlan['pipeline'],
    extension: plan.extension,
    requiresFfmpeg: plan.requiresFfmpeg,
    video: plan.video,
    audio: plan.audio,
    maxMemoryMb,
    segmentConcurrency,
    recordMaxMb: record.mb,
    recordMaxMinutes: record.minutes,
  };
}

async function settle(id: string, code: JobErrorCode, message: string): Promise<void> {
  const job = await updateJob(id, (j) => failJob(j, Date.now(), { code, message }));
  if (job?.stage === 'failed') await notifyJob(job);
  await afterJobEnds(id);
}

async function afterJobEnds(id: string): Promise<void> {
  meters.delete(id);
  await removeReplay(id);
  const job = await getJob(id);
  if (job?.viaOffscreen) {
    await releaseInOffscreen(id);
    const stillBusy = (await listJobs()).some((j) => j.viaOffscreen && isActive(j));
    if (!stillBusy) await closeOffscreen().catch(() => undefined);
  }
  void pump();
}

async function runJob(id: string): Promise<void> {
  try {
    const job = await getJob(id);
    if (!job || job.stage !== 'preparing') return;
    const settings = await loadSettings();
    const plan = planFromRequest(job.request, limitsOf(settings));
    if (!plan.valid) return void (await settle(id, 'invalid', plan.issues.join(', ')));
    if (job.request.replay) {
      await installReplay(job.id, job.request.replay.frameUrl, job.request.replay.urls);
    }
    // A native download that Chrome's download manager could not make (no Referer) is run by the extension itself.
    if ((job.staged || job.request.held) && plan.pipeline === 'native') plan.pipeline = 'file-staged';
    if (plan.pipeline === 'native') await runNative(job);
    else {
      await runInOffscreenDoc(job, plan, settings.maxMemoryMb, settings.segmentConcurrency, {
        mb: settings.recordMaxMb,
        minutes: settings.recordMaxMinutes,
      });
      if (job.request.capture) void captureInPage(job);
      else if (job.request.record)
        void recordInPage(job, settings.recordMaxMinutes * 60, settings.recordMaxMb * 1024 * 1024);
      else if (job.request.held) void sendHeldBytes(job);
    }
  } catch (e) {
    log.error('job start failed:', e);
    await settle(id, 'unknown', e instanceof Error ? e.message : 'Failed to start');
  }
}

/** Run the capture in the page that owns the video; the offscreen document is already waiting for what it sends. */
async function captureInPage(job: DownloadJob): Promise<void> {
  const held = job.request.held;
  const speed = job.request.capture?.speed;
  if (!held || !speed) return;
  const res = await runCapture(job.request.tabId, held.frameId ?? 0, job.id, held.id, speed, {
    title: t('captureBanner'),
    cancel: t('captureCancel'),
    progress: t(speed === 'fast' ? 'captureProgressFast' : 'captureProgressRealtime', '$1'),
  });
  if (res.ok) return; // the offscreen document takes over from here
  // When the page gave up because the other side closed the connection, the offscreen document knows why: give it a
  // moment to say so before settling with the page's view of it.
  await new Promise((r) => setTimeout(r, 500));
  const now = await getJob(job.id);
  if (!now || !isActive(now)) return; // cancelled (or already failed) meanwhile
  await cancelInOffscreen(job.id);
  if (res.code === 'cancelled') {
    await updateJob(job.id, (j) =>
      canTransition(j.stage, 'cancelled') ? transition(j, 'cancelled', Date.now()) : j,
    );
    await afterJobEnds(job.id);
    return;
  }
  await settle(job.id, res.code === 'protected' ? 'protected' : 'capture', res.message);
}

/**
 * Record a MediaStream in the page that plays it; the offscreen document is already waiting for what it sends. The
 * recording moves the job to RECORDING as soon as the page has started, and ends when the user stops it or a limit hits.
 */
async function recordInPage(job: DownloadJob, maxSeconds: number, maxBytes: number): Promise<void> {
  const held = job.request.held;
  const record = job.request.record;
  if (!held || !record) return;
  const res = await runRecord(
    job.request.tabId,
    held.frameId ?? 0,
    job.id,
    held.id,
    { prefer: record.prefer, maxSeconds, maxBytes },
    { title: t('recordBanner'), cancel: t('captureCancel'), stop: t('recordStop'), progress: '$1' },
  );
  if (res.ok) return; // the offscreen document takes over from here
  await new Promise((r) => setTimeout(r, 500));
  const now = await getJob(job.id);
  // Past RECORDING the offscreen document has the recording (e.g. the tab was closed): nothing is to be undone.
  if (!now || (now.stage !== 'preparing' && now.stage !== 'recording')) return;
  await cancelInOffscreen(job.id);
  if (res.code === 'cancelled') {
    await updateJob(job.id, (j) =>
      canTransition(j.stage, 'cancelled') ? transition(j, 'cancelled', Date.now()) : j,
    );
    await afterJobEnds(job.id);
    return;
  }
  await settle(job.id, res.code === 'protected' ? 'protected' : 'capture', res.message);
}

/** The offscreen document is waiting for the bytes: tell the page that holds them to send them now. */
async function sendHeldBytes(job: DownloadJob): Promise<void> {
  const held = job.request.held;
  if (!held) return;
  const res = await pumpHeld(job.request.tabId, held.frameId ?? 0, job.id, held.id);
  if (res.ok) return;
  // The offscreen side fails on its own after a timeout; this just reports the real reason straight away.
  const now = await getJob(job.id);
  if (now && isActive(now)) {
    await cancelInOffscreen(job.id);
    await settle(job.id, 'network', res.error);
  }
}

async function runNative(job: DownloadJob): Promise<void> {
  let downloadId: number;
  try {
    downloadId = await startChromeDownload(job.request.sourceUrl, job.request);
  } catch (e) {
    return void (await settle(
      job.id,
      'chrome-download',
      e instanceof Error ? e.message : 'Chrome refused the download',
    ));
  }
  const updated = await updateJob(job.id, (j) =>
    canTransition(j.stage, 'downloading')
      ? { ...transition(j, 'downloading', Date.now()), chromeDownloadId: downloadId }
      : j,
  );
  // Cancelled while Chrome was starting the download.
  if (!updated || isTerminal(updated)) await chrome.downloads.cancel(downloadId).catch(() => undefined);
  startPolling();
}

async function runInOffscreenDoc(
  job: DownloadJob,
  plan: Plan,
  maxMemoryMb: number,
  concurrency: number,
  record: { mb: number; minutes: number },
): Promise<void> {
  await runInOffscreen(job.id, job.request, offscreenPlan(plan, maxMemoryMb, concurrency, record));
}

// ---------------------------------------------------------------------------------------------------------------
// Offscreen events

/** "Clip.mp4" -> "Clip (part 2).mkv" when the pipeline decided the extension and the capture was split. */
export function partFileName(
  filename: string,
  extension: string | undefined,
  part: number | undefined,
): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = extension ?? (dot > 0 ? filename.slice(dot + 1) : '');
  const name = part === undefined ? stem : `${stem} (part ${part})`;
  return ext ? `${name}.${ext}` : name;
}

/** A further part of a split capture, as a job that is already past the point where it fetches anything. */
function childJob(parent: DownloadJob, id: string, request: DownloadRequest, now: number): DownloadJob {
  return {
    ...parent,
    id,
    request,
    stage: 'downloading',
    stages: parent.stages,
    progress: {},
    paused: false,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    viaOffscreen: true,
  };
}

const OFFSCREEN_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  'capture',
  'cors',
  'http-error',
  'network',
  'protected',
  'too-large',
  'out-of-memory',
  'ffmpeg',
  'decrypt',
  'invalid',
]);

export async function handleOffscreenEvent(ev: OffscreenEvent): Promise<void> {
  const now = Date.now();
  switch (ev.type) {
    case 'stage':
      await updateJob(ev.jobId, (j) => (canTransition(j.stage, ev.stage) ? transition(j, ev.stage, now) : j));
      return;
    case 'progress':
      await updateJob(ev.jobId, (j) => (isActive(j) ? withProgress(j, ev.progress, now) : j));
      return;
    case 'ready': {
      const job = await getJob(ev.jobId);
      if (!job || isTerminal(job)) {
        for (const p of ev.extraParts ?? []) await releaseInOffscreen(p.jobId);
        return void (await releaseInOffscreen(ev.jobId));
      }
      // Only a blob this extension's own offscreen document made may be handed to Chrome's download manager.
      if (!isOwnBlobUrl(ev.blobUrl) || (ev.extraParts ?? []).some((p) => !isOwnBlobUrl(p.blobUrl)))
        return void (await settle(ev.jobId, 'unknown', 'The converted file did not come from the extension'));
      // A capture that switched quality becomes several files: each further part is a job of its own, recorded before
      // any download starts so the offscreen document is not closed while one of them is still being saved.
      const total = 1 + (ev.extraParts?.length ?? 0);
      const named = (index: number, extension: string | undefined): DownloadRequest => ({
        ...job.request,
        filename: partFileName(job.request.filename, extension, total > 1 ? index + 1 : undefined),
      });
      for (const [i, p] of (ev.extraParts ?? []).entries()) {
        await putJob(childJob(job, p.jobId, named(i + 1, p.extension), now));
      }
      const parts = [
        { id: ev.jobId, url: ev.blobUrl, bytes: ev.bytes, request: named(0, ev.extension) },
        ...(ev.extraParts ?? []).map((p, i) => ({
          id: p.jobId,
          url: p.blobUrl,
          bytes: p.bytes,
          request: named(i + 1, p.extension),
        })),
      ];
      for (const part of parts) {
        try {
          await updateJob(part.id, (j) => ({ ...j, request: part.request }));
          const downloadId = await startChromeDownload(part.url, part.request);
          await updateJob(part.id, (j) => ({
            ...withProgress(j, { fraction: 1, bytesDone: part.bytes, bytesTotal: part.bytes }, now),
            chromeDownloadId: downloadId,
            ...(ev.skipped && part.id === ev.jobId ? { skipped: ev.skipped } : {}),
            ...(ev.gaps && part.id === ev.jobId ? { gaps: ev.gaps } : {}),
            ...(ev.keptOriginal && part.id === ev.jobId ? { keptOriginal: true } : {}),
          }));
          startPolling();
        } catch (e) {
          await settle(
            part.id,
            'chrome-download',
            e instanceof Error ? e.message : 'Chrome refused the file',
          );
        }
      }
      return;
    }
    case 'failed': {
      const code = (OFFSCREEN_CODES.has(ev.code) ? ev.code : 'unknown') as JobErrorCode;
      await settle(ev.jobId, code, ev.message);
      return;
    }
    case 'cancelled': {
      await updateJob(ev.jobId, (j) =>
        canTransition(j.stage, 'cancelled') ? transition(j, 'cancelled', now) : j,
      );
      await afterJobEnds(ev.jobId);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Chrome download monitoring (native downloads, and the final hand-off of assembled files)

export function startPolling(): void {
  if (polling) return;
  polling = true;
  void (async () => {
    try {
      for (;;) {
        const jobs = (await listJobs()).filter((j) => j.chromeDownloadId !== undefined && isActive(j));
        if (jobs.length === 0) break;
        for (const j of jobs) await syncFromChrome(j);
        // Each iteration calls extension APIs, which also keeps the service worker alive while downloading.
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      polling = false;
    }
  })();
}

export async function syncById(downloadId: number): Promise<void> {
  const job = (await listJobs()).find((j) => j.chromeDownloadId === downloadId && isActive(j));
  if (job) await syncFromChrome(job);
}

async function syncFromChrome(job: DownloadJob): Promise<void> {
  if (job.chromeDownloadId === undefined) return;
  const [item] = await chrome.downloads.search({ id: job.chromeDownloadId });
  const now = Date.now();
  if (!item) {
    return void (await settle(job.id, 'chrome-download', 'The download was removed from Chrome'));
  }
  if (item.state === 'complete') {
    const done = await updateJob(job.id, (j) =>
      canTransition(j.stage, 'completed')
        ? { ...transition(j, 'completed', now), filePath: item.filename }
        : j,
    );
    if (done?.stage === 'completed') await notifyJob(done);
    await afterJobEnds(job.id);
    return;
  }
  if (item.state === 'interrupted') {
    if (canRestage(job, item.error)) {
      const next = await updateJob(job.id, (j) => (canRestage(j, item.error) ? restage(j, now) : j));
      if (next?.staged) {
        void runJob(job.id);
        return;
      }
    }
    if (item.error === 'USER_CANCELED') {
      await updateJob(job.id, (j) =>
        canTransition(j.stage, 'cancelled') ? transition(j, 'cancelled', now) : j,
      );
      await afterJobEnds(job.id);
    } else {
      await settle(job.id, 'chrome-download', item.error ?? 'Interrupted');
    }
    return;
  }
  // in_progress
  if (job.viaOffscreen) {
    await updateJob(job.id, (j) => ({ ...j, paused: item.paused }));
    return;
  }
  let meter = meters.get(job.id);
  if (!meter) meters.set(job.id, (meter = new SpeedMeter()));
  meter.update(item.bytesReceived, now);
  const total = item.totalBytes > 0 ? item.totalBytes : undefined;
  const progress: DownloadJob['progress'] = { bytesDone: item.bytesReceived };
  if (total !== undefined) {
    progress.bytesTotal = total;
    progress.fraction = Math.min(1, item.bytesReceived / total);
  }
  const speed = meter.bytesPerSecond;
  if (speed !== undefined) progress.bytesPerSecond = speed;
  const eta = meter.etaSeconds(total === undefined ? undefined : total - item.bytesReceived);
  if (eta !== undefined) progress.etaSeconds = eta;
  await updateJob(job.id, (j) => ({ ...withProgress(j, progress, now), paused: item.paused }));
}

// ---------------------------------------------------------------------------------------------------------------
// User actions

export async function jobAction(
  jobId: string,
  action: 'cancel' | 'retry' | 'pause' | 'resume' | 'remove' | 'stop',
): Promise<Result<object>> {
  const job = await getJob(jobId);
  if (!job) return fail('not-found');
  const now = Date.now();
  switch (action) {
    case 'cancel': {
      if (isTerminal(job)) return ok();
      if (job.chromeDownloadId !== undefined)
        await chrome.downloads.cancel(job.chromeDownloadId).catch(() => undefined);
      if (job.viaOffscreen) await cancelInOffscreen(jobId);
      if ((job.request.capture || job.request.record) && job.request.held)
        await stopCapture(job.request.tabId, job.request.held.frameId ?? 0, jobId);
      await updateJob(jobId, (j) =>
        canTransition(j.stage, 'cancelled') ? transition(j, 'cancelled', now) : j,
      );
      await afterJobEnds(jobId);
      return ok();
    }
    case 'stop': {
      // Stop and save: the recording ends here and what was recorded is kept (cancel would discard it).
      if (!canStop(job)) return fail('not-supported');
      if (job.request.liveRecord) await stopInOffscreen(jobId);
      else if (job.request.held)
        await finishRecordingInPage(job.request.tabId, job.request.held.frameId ?? 0, jobId);
      else return fail('not-supported');
      return ok();
    }
    case 'retry': {
      if (!canRetry(job)) return fail('not-retryable');
      await updateJob(jobId, (j) => retryJob(j, now));
      void pump();
      return ok();
    }
    case 'pause':
    case 'resume': {
      if (!job.canPause || job.chromeDownloadId === undefined || !isActive(job)) return fail('not-supported');
      try {
        if (action === 'pause') await chrome.downloads.pause(job.chromeDownloadId);
        else await chrome.downloads.resume(job.chromeDownloadId);
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'failed');
      }
      await updateJob(jobId, (j) => ({ ...j, paused: action === 'pause' }));
      startPolling();
      return ok();
    }
    case 'remove': {
      if (!isTerminal(job)) return fail('still-running');
      await removeJobs((j) => j.id === jobId);
      return ok();
    }
  }
}

export async function clearHistory(): Promise<void> {
  await removeJobs((j) => isTerminal(j));
}

/**
 * Called on every service-worker start. Native downloads keep running inside Chrome, so monitoring just resumes.
 * Segment/FFmpeg jobs need their offscreen document: if it is gone (browser restart), they were interrupted.
 */
export async function reconcile(): Promise<void> {
  const alive = await offscreenAlive().catch(() => false);
  const now = Date.now();
  await mutateJobs((jobs) => {
    for (const j of Object.values(jobs)) {
      if (!isActive(j) || !j.viaOffscreen || alive) continue;
      if (j.chromeDownloadId !== undefined) continue; // handed to Chrome: Chrome still owns it
      jobs[j.id] = failJob(j, now, { code: 'interrupted', message: 'Interrupted by a browser restart' });
    }
  });
  await pruneReplay((await listJobs()).filter(isActive).map((j) => j.id));
  startPolling();
  void pump();
}
