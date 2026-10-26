import type { DownloadJob } from '@/types/download';

const KEY = 'jobs';
let chain: Promise<unknown> = Promise.resolve();

type JobMap = Record<string, DownloadJob>;

/** All reads-modify-writes go through one queue so concurrent events cannot lose each other's updates. */
export function mutateJobs<T>(fn: (jobs: JobMap) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const stored = await chrome.storage.local.get(KEY);
    const jobs = (stored[KEY] as JobMap | undefined) ?? {};
    const result = await fn(jobs);
    await chrome.storage.local.set({ [KEY]: jobs });
    return result;
  });
  chain = run.catch(() => undefined);
  return run;
}

export async function listJobs(): Promise<DownloadJob[]> {
  const stored = await chrome.storage.local.get(KEY);
  const jobs = Object.values((stored[KEY] as JobMap | undefined) ?? {});
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id: string): Promise<DownloadJob | undefined> {
  const stored = await chrome.storage.local.get(KEY);
  return ((stored[KEY] as JobMap | undefined) ?? {})[id];
}

/** Apply `fn` to one job. Returns the new job, or undefined if the job is gone or `fn` returns undefined. */
export function updateJob(
  id: string,
  fn: (job: DownloadJob) => DownloadJob | undefined,
): Promise<DownloadJob | undefined> {
  return mutateJobs((jobs) => {
    const cur = jobs[id];
    if (!cur) return undefined;
    const next = fn(cur);
    if (next) jobs[id] = next;
    return next;
  });
}

export function putJob(job: DownloadJob): Promise<void> {
  return mutateJobs((jobs) => {
    jobs[job.id] = job;
  });
}

export function removeJobs(pred: (j: DownloadJob) => boolean): Promise<number> {
  return mutateJobs((jobs) => {
    let n = 0;
    for (const [id, j] of Object.entries(jobs)) {
      if (pred(j)) {
        delete jobs[id];
        n++;
      }
    }
    return n;
  });
}
