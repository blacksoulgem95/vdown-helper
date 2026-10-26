import { planFromRequest, sanitizeRequest } from '@/lib/request';
import { loadSettings } from '@/lib/settings';
import {
  SpeedMeter,
  canRetry,
  canTransition,
  createJob,
  failJob,
  isActive,
  isQueued,
  isTerminal,
  retryJob,
  transition,
  withProgress,
} from '@/lib/queue';
import { asciiFileName, log } from '@/lib/security';
import type { Plan } from '@/lib/compat';
import type { DownloadJob, DownloadRequest, JobErrorCode } from '@/types/download';
import type { OffscreenEvent, OffscreenPlan, Result } from '@/types/messages';
import { inspectVariant } from './detect';
import { getJob, listJobs, mutateJobs, putJob, removeJobs, updateJob } from './jobStore';
import { notifyJob } from './notify';
import {
  cancelInOffscreen,
  closeOffscreen,
  offscreenAlive,
  releaseInOffscreen,
  runInOffscreen,
} from './offscreenBridge';

const meters = new Map<string, SpeedMeter>();
let polling = false;

const ok = (): Result<object> => ({ ok: true });
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

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
  let req = clean;
  if (req.isHls) {
    try {
      const ins = await inspectVariant(req.tabId, req.sourceUrl);
      if (ins.protectedByDrm) return fail('protected');
      req = { ...req, fragmented: ins.fragmented, live: ins.live, durationSec: ins.durationSec };
      if (req.audioUrl) {
        const aud = await inspectVariant(req.tabId, req.audioUrl);
        if (aud.protectedByDrm) return fail('protected');
        if (aud.live) req = { ...req, live: true };
      }
    } catch (e) {
      return fail(`inspect:${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  const plan = planFromRequest(req, limitsOf(settings));
  if (!plan.valid) return fail(`plan:${plan.issues.join(',')}`);

  const job = createJob(crypto.randomUUID(), req, plan, Date.now());
  if (plan.pipeline !== 'native') job.viaOffscreen = true;
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

function offscreenPlan(plan: Plan, maxMemoryMb: number, segmentConcurrency: number): OffscreenPlan {
  return {
    pipeline: plan.pipeline as OffscreenPlan['pipeline'],
    extension: plan.extension,
    requiresFfmpeg: plan.requiresFfmpeg,
    video: plan.video,
    audio: plan.audio,
    maxMemoryMb,
    segmentConcurrency,
  };
}

async function settle(id: string, code: JobErrorCode, message: string): Promise<void> {
  const job = await updateJob(id, (j) => failJob(j, Date.now(), { code, message }));
  if (job?.stage === 'failed') await notifyJob(job);
  await afterJobEnds(id);
}

async function afterJobEnds(id: string): Promise<void> {
  meters.delete(id);
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
    if (plan.pipeline === 'native') await runNative(job);
    else await runInOffscreenDoc(job, plan, settings.maxMemoryMb, settings.segmentConcurrency);
  } catch (e) {
    log.error('job start failed:', e);
    await settle(id, 'unknown', e instanceof Error ? e.message : 'Failed to start');
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
): Promise<void> {
  await runInOffscreen(job.id, job.request, offscreenPlan(plan, maxMemoryMb, concurrency));
}

// ---------------------------------------------------------------------------------------------------------------
// Offscreen events

const OFFSCREEN_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
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
      if (!job || isTerminal(job)) return void (await releaseInOffscreen(ev.jobId));
      try {
        const downloadId = await startChromeDownload(ev.blobUrl, job.request);
        await updateJob(ev.jobId, (j) => ({
          ...withProgress(j, { fraction: 1, bytesDone: ev.bytes, bytesTotal: ev.bytes }, now),
          chromeDownloadId: downloadId,
        }));
        startPolling();
      } catch (e) {
        await settle(ev.jobId, 'chrome-download', e instanceof Error ? e.message : 'Chrome refused the file');
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
  action: 'cancel' | 'retry' | 'pause' | 'resume' | 'remove',
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
      await updateJob(jobId, (j) =>
        canTransition(j.stage, 'cancelled') ? transition(j, 'cancelled', now) : j,
      );
      await afterJobEnds(jobId);
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
  startPolling();
  void pump();
}
