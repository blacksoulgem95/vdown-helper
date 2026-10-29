import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobAction, pump, reconcile, submit } from '@/background/runner';
import { getJob, listJobs, putJob } from '@/background/jobStore';
import { DESKTOP_KEY } from '@/lib/desktop';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/lib/settings';
import { createJob, transition } from '@/lib/queue';
import type { Plan } from '@/lib/compat';
import type { DownloadRequest } from '@/types/download';
import { FakeEvent, installFakeChrome } from './helpers/fake-chrome';

const request = (over: Partial<DownloadRequest> = {}): DownloadRequest => ({
  resourceId: 'r1',
  sourceUrl: 'https://a.com/clip.mp4',
  tabId: 1,
  pageUrl: 'https://a.com/watch',
  host: 'a.com',
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  filename: 'clip.mp4',
  subfolder: '',
  qualityLabel: '720p',
  sourceFormat: 'mp4',
  isHls: false,
  hasMuxedAudio: true,
  hasVideo: true,
  credentialedOrigins: ['https://a.com'],
  ...over,
});
const plan: Plan = {
  valid: true,
  issues: [],
  pipeline: 'native',
  requiresFfmpeg: false,
  video: 'copy',
  audio: 'copy',
  extension: 'mp4',
  usesBitrate: false,
};

type Msg = Record<string, unknown>;

/** A native port to a pretend desktop app: it answers hello and accepts (or refuses) jobs; tests push the rest. */
class FakePort {
  sent: Msg[] = [];
  onMessage = new FakeEvent<[unknown]>();
  onDisconnect = new FakeEvent<[]>();
  refuse: Msg | undefined;
  postMessage = (m: Msg) => {
    this.sent.push(m);
    queueMicrotask(() => {
      if (m['type'] === 'hello') this.app({ type: 'hello', appVersion: '0.1.0', ffmpeg: '7.1' });
      if (m['type'] === 'run-job')
        this.app(
          this.refuse
            ? { ...this.refuse, jobId: m['jobId'] }
            : {
                type: 'accepted',
                jobId: m['jobId'],
                stages: ['detected', 'preparing', 'downloading', 'completed'],
              },
        );
    });
  };
  disconnect = vi.fn(() => undefined);
  app(m: Msg) {
    this.onMessage.emit({ v: 1, ...m });
  }
  of(type: string) {
    return this.sent.filter((m) => m['type'] === type);
  }
}

let port: FakePort;
let granted: { permissions: string[]; origins: string[] };

function setup(opts: { enabled?: boolean; routing?: string } = {}) {
  const fake = installFakeChrome() as unknown as Record<string, unknown> & {
    storage: { local: { data: Record<string, unknown> } };
    runtime: Record<string, unknown>;
  };
  fake.storage.local.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
  fake.storage.local.data[DESKTOP_KEY] = {
    enabled: opts.enabled ?? true,
    routing: opts.routing ?? 'streams',
  };
  port = new FakePort();
  granted = { permissions: ['nativeMessaging'], origins: [] };
  fake.runtime['connectNative'] = vi.fn(() => port);
  fake.runtime['getManifest'] = () => ({ version: '1.3.0' });
  fake.runtime['ContextType'] = { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
  fake.runtime['getContexts'] = vi.fn(async () => []);
  fake['permissions'] = {
    contains: vi.fn(
      async (p: { permissions?: string[]; origins?: string[] }) =>
        [...(p.permissions ?? [])].every((x) => granted.permissions.includes(x)) &&
        [...(p.origins ?? [])].every((x) => granted.origins.includes(x)),
    ),
  };
  fake['cookies'] = {
    getAll: vi.fn(async () => [
      { name: 'sid', value: 's3cret' },
      { name: 'lang', value: 'it' },
    ]),
  };
  fake['notifications'] = { create: vi.fn(async () => 'n') };
  fake['downloads'] = { download: vi.fn(async () => 1), search: vi.fn(async () => []) };
  fake['tabs'] = { get: vi.fn(async () => ({ id: 1, url: 'https://a.com/watch' })) };
  return fake;
}

const handedOver = async (over: Partial<DownloadRequest> = {}) => {
  const job = { ...createJob('job-1', request(over), plan, 1), viaDesktop: true };
  await putJob(job);
  await pump();
  await vi.waitFor(() => expect(port.of('run-job')).toHaveLength(1));
  return job;
};

describe('jobs the desktop app runs', () => {
  beforeEach(() => void setup());
  // the module keeps its port: close it after each test, as Chrome would when the app goes away
  afterEach(() => port.onDisconnect.emit());

  it('are handed over with the request and the replayable headers, then mirror what the app reports', async () => {
    await handedOver();
    const run = port.of('run-job')[0] as Msg;
    expect(run['v']).toBe(1);
    expect(run['jobId']).toBe('job-1');
    expect((run['request'] as Msg)['sourceUrl']).toBe('https://a.com/clip.mp4');
    expect(run['cookies']).toEqual([]); // no cookies permission: none are read
    await vi.waitFor(async () => expect((await getJob('job-1'))?.stages).toContain('downloading'));
    port.app({ type: 'stage', jobId: 'job-1', stage: 'downloading' });
    // a bare end stage is not the end: that comes with the file
    port.app({ type: 'stage', jobId: 'job-1', stage: 'completed' });
    port.app({ type: 'progress', jobId: 'job-1', progress: { fraction: 0.5, bytesDone: 50 } });
    await vi.waitFor(async () => expect((await getJob('job-1'))?.progress.fraction).toBe(0.5));
    expect((await getJob('job-1'))?.stage).toBe('downloading');
    port.app({ type: 'done', jobId: 'job-1', path: '/home/u/Downloads/vdown-helper/clip.mp4', bytes: 100 });
    await vi.waitFor(async () => expect((await getJob('job-1'))?.stage).toBe('completed'));
    const done = await getJob('job-1');
    expect(done?.filePath).toBe('/home/u/Downloads/vdown-helper/clip.mp4');
    expect(done?.chromeDownloadId).toBeUndefined();
  });

  it('take no download slot of their own', async () => {
    // a running Chrome download fills the only slot; the desktop job is handed over anyway
    const s = setup();
    s.storage.local.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, maxConcurrentDownloads: 1 };
    await putJob(transition(createJob('job-chrome', request(), plan, 0), 'preparing', 1));
    await handedOver();
  });

  it('send the cookies of granted origins only, and again when the app asks after a restart', async () => {
    granted = { permissions: ['nativeMessaging', 'cookies'], origins: ['https://a.com/*'] };
    await handedOver({ credentialedOrigins: ['https://a.com', 'https://b.com'] });
    expect((port.of('run-job')[0] as Msg)['cookies']).toEqual([
      { origin: 'https://a.com', header: 'sid=s3cret; lang=it' },
    ]);
    port.app({ type: 'needs-cookies', jobId: 'job-1', origins: ['https://a.com'] });
    await vi.waitFor(() => expect(port.of('cookies')).toHaveLength(1));
    expect(port.of('cookies')[0]).toMatchObject({ jobId: 'job-1', cookies: [{ origin: 'https://a.com' }] });
    // a job that is not the app's to run gets nothing
    port.app({ type: 'needs-cookies', jobId: 'someone-else', origins: ['https://a.com'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(port.of('cookies')).toHaveLength(1);
  });

  it("fail with the app's reason when it refuses one (a protected stream)", async () => {
    port.refuse = { type: 'error', code: 'protected', message: 'This stream is protected' };
    await handedOver();
    await vi.waitFor(async () => expect((await getJob('job-1'))?.stage).toBe('failed'));
    expect((await getJob('job-1'))?.error?.code).toBe('protected');
  });

  it('cancel, pause and resume go to the app', async () => {
    await handedOver();
    await vi.waitFor(async () => expect((await getJob('job-1'))?.stage).toBe('preparing'));
    expect((await jobAction('job-1', 'pause')).ok).toBe(true);
    expect((await getJob('job-1'))?.paused).toBe(true);
    expect((await jobAction('job-1', 'resume')).ok).toBe(true);
    expect((await jobAction('job-1', 'cancel')).ok).toBe(true);
    expect(port.sent.map((m) => m['type'])).toEqual(['hello', 'run-job', 'pause', 'resume', 'cancel']);
    expect((await getJob('job-1'))?.stage).toBe('cancelled');
  });

  it('after the worker restarts, ask the app where they are; one it lost fails', async () => {
    await putJob({ ...transition(createJob('job-1', request(), plan, 1), 'preparing', 2), viaDesktop: true });
    await putJob({ ...transition(createJob('job-2', request(), plan, 1), 'preparing', 2), viaDesktop: true });
    await reconcile();
    await vi.waitFor(() => expect(port.of('status')).toHaveLength(1));
    expect(port.of('status')[0]?.['jobIds']).toEqual(['job-1', 'job-2']);
    port.app({
      type: 'status',
      jobs: [
        { jobId: 'job-1', stage: 'downloading', progress: { fraction: 0.25 } },
        { jobId: 'job-2', stage: 'gone' },
      ],
    });
    await vi.waitFor(async () => expect((await getJob('job-2'))?.stage).toBe('failed'));
    expect((await getJob('job-2'))?.error?.code).toBe('desktop');
    expect((await getJob('job-1'))?.stage).toBe('downloading');
    expect((await getJob('job-1'))?.progress.fraction).toBe(0.25);
  });

  it('fail clearly when the app cannot be reached', async () => {
    const s = setup();
    s.runtime['connectNative'] = vi.fn(() => {
      throw new Error('Specified native messaging host not found.');
    });
    await putJob({ ...createJob('job-1', request(), plan, 1), viaDesktop: true });
    await pump();
    await vi.waitFor(async () => expect((await getJob('job-1'))?.stage).toBe('failed'));
    expect((await getJob('job-1'))?.error).toMatchObject({ code: 'desktop' });
  });
});

describe('routing at submit', () => {
  afterEach(() => port.onDisconnect.emit());

  it('a direct file stays in Chrome; Send to desktop app hands it over', async () => {
    setup({ routing: 'streams' });
    const local = await submit(request());
    expect(local.ok).toBe(true);
    const sent = await submit({ ...request(), resourceId: 'r2' }, true);
    expect(sent.ok).toBe(true);
    const jobs = await listJobs();
    expect(jobs.filter((j) => j.viaDesktop)).toHaveLength(1);
    expect(jobs.filter((j) => !j.viaDesktop)).toHaveLength(1);
  });

  it('nothing goes to the app while it is off', async () => {
    setup({ enabled: false });
    await submit(request(), true);
    expect((await listJobs()).some((j) => j.viaDesktop)).toBe(false);
  });
});
