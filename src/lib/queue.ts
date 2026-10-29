/** The job state machine. Implemented in Rust (`core/src/queue.rs`). */
import type { DownloadJob, DownloadRequest, JobError, JobProgress, JobStage } from '@/types/download';
import type { Plan } from './compat';
import { core } from './core';

const STAGES: readonly JobStage[] = [
  'detected',
  'preparing',
  'downloading',
  'recording',
  'merging',
  'encoding',
  'completed',
  'failed',
  'cancelled',
];

/** Allowed stage transitions. Retry is a separate, explicit operation (see retryJob). */
export const TRANSITIONS: Readonly<Record<JobStage, readonly JobStage[]>> = Object.fromEntries(
  STAGES.map((s) => [s, core.transitionsFrom(s) as JobStage[]]),
) as Record<JobStage, JobStage[]>;

export const ACTIVE_STAGES: readonly JobStage[] = STAGES.filter((s) => core.isActiveStage(s));
export const TERMINAL_STAGES: readonly JobStage[] = STAGES.filter((s) => core.isTerminalStage(s));

export const isActive = (j: Pick<DownloadJob, 'stage'>): boolean => core.isActiveStage(j.stage);
export const isTerminal = (j: Pick<DownloadJob, 'stage'>): boolean => core.isTerminalStage(j.stage);
export const isQueued = (j: Pick<DownloadJob, 'stage'>): boolean => j.stage === 'detected';

/** Finished jobs the popup keeps in view; the rest is one click away, so history never buries the page. */
export const POPUP_FINISHED = 3;

/**
 * The jobs the popup shows (newest first, as given): every job still running or waiting, then the most recent
 * finished ones. `hidden` is how many finished jobs are left out.
 */
export function popupQueue<J extends Pick<DownloadJob, 'stage'>>(
  jobs: readonly J[],
  keep = POPUP_FINISHED,
): { shown: J[]; hidden: number } {
  const shown = [
    ...core.popupQueue(
      jobs.map((j) => j.stage),
      keep,
    ),
  ].map((i) => jobs[i] as J);
  return { shown, hidden: jobs.length - shown.length };
}

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
  return core.stagesFor(plan) as JobStage[];
}

export function createJob(id: string, request: DownloadRequest, plan: Plan, now: number): DownloadJob {
  return core.createJob(id, request, plan, now) as DownloadJob;
}

export function canTransition(from: JobStage, to: JobStage): boolean {
  return core.canTransition(from, to);
}

/** Returns the job moved to `to`. Throws IllegalTransitionError for invalid moves. */
export function transition(job: DownloadJob, to: JobStage, now: number, error?: JobError): DownloadJob {
  const next = core.transition(job, to, now, error) as DownloadJob | undefined;
  if (!next) throw new IllegalTransitionError(job.stage, to);
  return next;
}

/** The job failed with `error`; a job that can no longer fail is returned as it is. */
export function failJob(job: DownloadJob, now: number, error: JobError): DownloadJob {
  return canTransition(job.stage, 'failed') ? transition(job, 'failed', now, error) : job;
}

export function canRetry(job: DownloadJob): boolean {
  return job.stage === 'failed' || job.stage === 'cancelled';
}

/** A running recording can be stopped (and saved), which is different from cancelling it. */
export const canStop = (j: Pick<DownloadJob, 'stage'>): boolean => j.stage === 'recording';

/** Reset a failed/cancelled job so the scheduler picks it up again. */
export function retryJob(job: DownloadJob, now: number): DownloadJob {
  const next = core.retryJob(job, now) as DownloadJob | undefined;
  if (!next) throw new IllegalTransitionError(job.stage, 'detected');
  return next;
}

export function withProgress(job: DownloadJob, progress: JobProgress, now: number): DownloadJob {
  return core.withProgress(job, progress, now) as DownloadJob;
}

/**
 * Exponentially smoothed throughput meter. Reports undefined until it has at least ~1.5 s of samples, and the
 * ETA only once the rate is both positive and stable, so the UI never shows a wild early guess.
 */
export class SpeedMeter {
  /** The meter's state, kept here and advanced by the core. */
  private state: unknown = {};

  update(bytes: number, nowMs: number): void {
    this.state = core.speedUpdate(this.state, bytes, nowMs);
  }

  get bytesPerSecond(): number | undefined {
    return core.speedRate(this.state);
  }

  etaSeconds(remainingBytes: number | undefined): number | undefined {
    return core.speedEta(this.state, remainingBytes);
  }
}

/** A native download the server refused (SERVER_FORBIDDEN, SERVER_UNAUTHORIZED) is worth one retry with the frame's headers. */
export function canRestage(job: DownloadJob, chromeError: string | undefined): boolean {
  return core.canRestage(job, chromeError);
}

/**
 * Hand a refused native download to the extension's own fetch pipeline (once). The job goes back to PREPARING so the
 * runner starts it again; it cannot be paused any more because Chrome no longer owns the transfer.
 */
export function restage(job: DownloadJob, now: number): DownloadJob {
  const next = core.restage(job, now) as DownloadJob | undefined;
  if (!next) throw new IllegalTransitionError(job.stage, 'preparing');
  return next;
}
