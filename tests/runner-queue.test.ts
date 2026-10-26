import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobAction, pump, reconcile } from '@/background/runner';
import { listJobs, putJob } from '@/background/jobStore';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/lib/settings';
import { createJob, transition } from '@/lib/queue';
import type { Plan } from '@/lib/compat';
import type { DownloadJob, DownloadRequest } from '@/types/download';
import { installFakeChrome } from './helpers/fake-chrome';

const request = (name: string): DownloadRequest => ({
  resourceId: name,
  sourceUrl: `https://a.com/${name}.mp4`,
  tabId: 1,
  pageUrl: 'https://a.com/',
  host: 'a.com',
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  filename: `${name}.mp4`,
  subfolder: '',
  qualityLabel: '',
  sourceFormat: 'mp4',
  isHls: false,
  hasMuxedAudio: true,
  hasVideo: true,
});
const plan = (over: Partial<Plan> = {}): Plan => ({
  valid: true,
  issues: [],
  pipeline: 'native',
  requiresFfmpeg: false,
  video: 'copy',
  audio: 'copy',
  extension: 'mp4',
  usesBitrate: false,
  ...over,
});

let nextDownloadId = 100;
function setup(maxConcurrent: number) {
  const fake = installFakeChrome() as unknown as Record<string, unknown> & {
    storage: { local: { data: Record<string, unknown> } };
  };
  fake.storage.local.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, maxConcurrentDownloads: maxConcurrent };
  fake['downloads'] = {
    download: vi.fn(async () => nextDownloadId++),
    cancel: vi.fn(async () => undefined),
    search: vi.fn(async ({ id }: { id: number }) => [
      { id, state: 'in_progress', bytesReceived: 0, totalBytes: 100, paused: false, exists: true },
    ]),
  };
  (fake['runtime'] as Record<string, unknown>)['ContextType'] = { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
  (fake['runtime'] as Record<string, unknown>)['getContexts'] = vi.fn(async () => []);
  fake['notifications'] = { create: vi.fn(async () => 'n') };
  return fake;
}
const queued = async (name: string, at: number, over: Partial<DownloadJob> = {}) => {
  const job = { ...createJob(`job-${name}`, request(name), plan(), at), ...over };
  await putJob(job);
  return job;
};
const stages = async () => Object.fromEntries((await listJobs()).map((j) => [j.id, j.stage]));

describe('queue scheduling', () => {
  beforeEach(() => void setup(1));

  it('starts no more jobs than the concurrency limit, oldest first', async () => {
    await queued('a', 1);
    await queued('b', 2);
    await queued('c', 3);
    await pump();
    await vi.waitFor(async () => expect((await stages())['job-a']).toBe('downloading'));
    expect(await stages()).toEqual({ 'job-a': 'downloading', 'job-b': 'detected', 'job-c': 'detected' });
  });

  it('starts the next queued job as soon as a slot frees up', async () => {
    await queued('a', 1);
    await queued('b', 2);
    await pump();
    await vi.waitFor(async () => expect((await stages())['job-a']).toBe('downloading'));
    await jobAction('job-a', 'cancel');
    await vi.waitFor(async () => expect((await stages())['job-b']).toBe('downloading'));
    expect((await stages())['job-a']).toBe('cancelled');
    await jobAction('job-b', 'cancel');
  });

  it('a higher limit runs jobs in parallel', async () => {
    setup(2);
    await queued('a', 1);
    await queued('b', 2);
    await queued('c', 3);
    await pump();
    await vi.waitFor(async () => {
      const s = await stages();
      expect([s['job-a'], s['job-b']]).toEqual(['downloading', 'downloading']);
    });
    expect((await stages())['job-c']).toBe('detected');
    await jobAction('job-a', 'cancel');
    await jobAction('job-b', 'cancel');
    await vi.waitFor(async () => expect((await stages())['job-c']).toBe('downloading'));
    await jobAction('job-c', 'cancel');
  });

  it('retry puts a failed job back in the queue and runs it again', async () => {
    const failed = transition(
      transition(createJob('job-x', request('x'), plan(), 1), 'preparing', 2),
      'failed',
      3,
      { code: 'network', message: 'offline' },
    );
    await putJob(failed);
    expect((await jobAction('job-x', 'retry')).ok).toBe(true);
    await vi.waitFor(async () => expect((await stages())['job-x']).toBe('downloading'));
    expect((await listJobs())[0]?.attempts).toBe(1);
    await jobAction('job-x', 'cancel');
  });

  it('refuses pause on jobs that cannot pause and remove on running jobs', async () => {
    const j = transition(
      createJob('job-p', request('p'), plan({ pipeline: 'hls-concat' }), 1),
      'preparing',
      2,
    );
    await putJob(j);
    expect(await jobAction('job-p', 'pause')).toMatchObject({ ok: false });
    expect(await jobAction('job-p', 'remove')).toMatchObject({ ok: false, error: 'still-running' });
    expect(await jobAction('missing', 'cancel')).toMatchObject({ ok: false, error: 'not-found' });
  });
});

describe('reconcile after the service worker (or browser) restarted', () => {
  beforeEach(() => void setup(5));

  it('fails segment/FFmpeg jobs whose offscreen document is gone, but keeps Chrome-owned downloads', async () => {
    const active = (name: string, over: Partial<DownloadJob>) =>
      queued(name, 1, {
        ...transition(createJob(`job-${name}`, request(name), plan(), 1), 'preparing', 2),
        ...over,
      });
    await active('lost', { viaOffscreen: true });
    await active('handed', { viaOffscreen: true, chromeDownloadId: 7 });
    await active('native', { chromeDownloadId: 8 });
    await reconcile();
    const jobs = Object.fromEntries((await listJobs()).map((j) => [j.id, j]));
    expect(jobs['job-lost']).toMatchObject({ stage: 'failed', error: { code: 'interrupted' } });
    expect(jobs['job-handed']?.stage).toBe('preparing');
    expect(jobs['job-native']?.stage).toBe('preparing');
    await jobAction('job-handed', 'cancel');
    await jobAction('job-native', 'cancel');
  });
});
