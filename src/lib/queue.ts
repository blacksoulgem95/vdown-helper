import type { DownloadJob, DownloadRequest, JobError, JobProgress, JobStage } from '@/types/download';
import type { Plan } from './compat';

/** Allowed stage transitions. Retry is a separate, explicit operation (see retryJob). */
export const TRANSITIONS: Readonly<Record<JobStage, readonly JobStage[]>> = {
  detected: ['preparing', 'cancelled', 'failed'],
  preparing: ['downloading', 'merging', 'encoding', 'cancelled', 'failed'],
  downloading: ['merging', 'encoding', 'completed', 'cancelled', 'failed'],
  merging: ['encoding', 'completed', 'cancelled', 'failed'],
  encoding: ['completed', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const ACTIVE_STAGES: readonly JobStage[] = ['preparing', 'downloading', 'merging', 'encoding'];
export const TERMINAL_STAGES: readonly JobStage[] = ['completed', 'failed', 'cancelled'];

export const isActive = (j: Pick<DownloadJob, 'stage'>): boolean => ACTIVE_STAGES.includes(j.stage);
export const isTerminal = (j: Pick<DownloadJob, 'stage'>): boolean => TERMINAL_STAGES.includes(j.stage);
export const isQueued = (j: Pick<DownloadJob, 'stage'>): boolean => j.stage === 'detected';

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobStage,
    readonly to: JobStage,
  ) {
    super(`Illegal job transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Only the stages this job will really pass through, in order (never a simulated one). */
export function stagesFor(plan: Pick<Plan, 'pipeline' | 'video' | 'audio' | 'requiresFfmpeg'>): JobStage[] {
  const stages: JobStage[] = ['detected', 'preparing', 'downloading'];
  if (plan.requiresFfmpeg) {
    const reencodes = plan.audio === 'transcode' || plan.video === 'transcode';
    stages.push(reencodes ? 'encoding' : 'merging');
  }
  stages.push('completed');
  return stages;
}

export function createJob(id: string, request: DownloadRequest, plan: Plan, now: number): DownloadJob {
  return {
    id,
    request,
    stage: 'detected',
    progress: {},
    stages: stagesFor(plan),
    // Only Chrome's own download manager supports pause/resume; the segment pipeline does not.
    canPause: plan.pipeline === 'native',
    paused: false,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
}

export function canTransition(from: JobStage, to: JobStage): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns the job moved to `to`. Throws IllegalTransitionError for invalid moves. */
export function transition(job: DownloadJob, to: JobStage, now: number, error?: JobError): DownloadJob {
  if (!canTransition(job.stage, to)) throw new IllegalTransitionError(job.stage, to);
  const next: DownloadJob = { ...job, stage: to, updatedAt: now, paused: false };
  if (to === 'failed' && error) next.error = error;
  if (to !== 'failed') delete next.error;
  if (isTerminal(next)) {
    next.finishedAt = now;
    if (to === 'completed') next.progress = { ...next.progress, fraction: 1 };
  } else {
    // A new stage restarts measurement; stale numbers from the previous stage would mislead.
    next.progress = {};
  }
  return next;
}

export function failJob(job: DownloadJob, now: number, error: JobError): DownloadJob {
  return canTransition(job.stage, 'failed') ? transition(job, 'failed', now, error) : job;
}

export function canRetry(job: DownloadJob): boolean {
  return job.stage === 'failed' || job.stage === 'cancelled';
}

/** Reset a failed/cancelled job so the scheduler picks it up again. */
export function retryJob(job: DownloadJob, now: number): DownloadJob {
  if (!canRetry(job)) throw new IllegalTransitionError(job.stage, 'detected');
  const next: DownloadJob = {
    ...job,
    stage: 'detected',
    progress: {},
    updatedAt: now,
    attempts: job.attempts + 1,
    paused: false,
  };
  delete next.error;
  delete next.finishedAt;
  delete next.chromeDownloadId;
  delete next.filePath;
  return next;
}

export function withProgress(job: DownloadJob, progress: JobProgress, now: number): DownloadJob {
  return { ...job, progress: { ...job.progress, ...progress }, updatedAt: now };
}

/**
 * Exponentially smoothed throughput meter. Reports undefined until it has at least ~1.5 s of samples, and the
 * ETA only once the rate is both positive and stable, so the UI never shows a wild early guess.
 */
export class SpeedMeter {
  private last?: { t: number; bytes: number };
  private firstT?: number;
  private rate?: number;
  private samples = 0;

  update(bytes: number, nowMs: number): void {
    if (this.firstT === undefined) this.firstT = nowMs;
    if (this.last && nowMs > this.last.t) {
      const inst = ((bytes - this.last.bytes) * 1000) / (nowMs - this.last.t);
      if (inst >= 0) {
        this.rate = this.rate === undefined ? inst : this.rate * 0.7 + inst * 0.3;
        this.samples++;
      }
    }
    this.last = { t: nowMs, bytes };
  }

  get bytesPerSecond(): number | undefined {
    if (this.rate === undefined || this.firstT === undefined || !this.last) return undefined;
    return this.last.t - this.firstT >= 1500 ? this.rate : undefined;
  }

  etaSeconds(remainingBytes: number | undefined): number | undefined {
    const r = this.bytesPerSecond;
    if (r === undefined || r <= 0 || remainingBytes === undefined || remainingBytes < 0 || this.samples < 3)
      return undefined;
    return remainingBytes / r;
  }
}

/** Chrome errors that mean "the server refused this request": worth one retry with the frame's headers replayed. */
export const REFUSED_BY_SERVER: readonly string[] = ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED'];

export function canRestage(job: DownloadJob, chromeError: string | undefined): boolean {
  return (
    job.stage === 'downloading' &&
    !job.staged &&
    job.request.replay !== undefined &&
    !job.request.isHls &&
    !job.request.isDash &&
    chromeError !== undefined &&
    REFUSED_BY_SERVER.includes(chromeError)
  );
}

/**
 * Hand a refused native download to the extension's own fetch pipeline (once). The job goes back to PREPARING so the
 * runner starts it again; it cannot be paused any more because Chrome no longer owns the transfer.
 */
export function restage(job: DownloadJob, now: number): DownloadJob {
  if (job.stage !== 'downloading' || job.staged) throw new IllegalTransitionError(job.stage, 'preparing');
  const next: DownloadJob = {
    ...job,
    stage: 'preparing',
    progress: {},
    updatedAt: now,
    paused: false,
    canPause: false,
    viaOffscreen: true,
    staged: true,
  };
  delete next.chromeDownloadId;
  delete next.error;
  return next;
}
