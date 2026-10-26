import { describe, expect, it } from 'vitest';
import type { Plan } from '@/lib/compat';
import {
  IllegalTransitionError,
  SpeedMeter,
  TRANSITIONS,
  canRetry,
  canStop,
  canTransition,
  createJob,
  failJob,
  isActive,
  retryJob,
  stagesFor,
  transition,
  withProgress,
} from '@/lib/queue';
import type { DownloadRequest, JobStage } from '@/types/download';

const request: DownloadRequest = {
  resourceId: 'r1',
  sourceUrl: 'https://a.com/v.mp4',
  tabId: 1,
  pageUrl: 'https://a.com/',
  host: 'a.com',
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  filename: 'v.mp4',
  subfolder: '',
  qualityLabel: '720p',
  sourceFormat: 'mp4',
  isHls: false,
  hasMuxedAudio: true,
  hasVideo: true,
};
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

describe('recording', () => {
  it('has its own stage instead of a download, and is the only thing that can be stopped (saved)', () => {
    expect(stagesFor(plan({ pipeline: 'record', requiresFfmpeg: true }))).toEqual([
      'detected',
      'preparing',
      'recording',
      'merging',
      'completed',
    ]);
    expect(canTransition('preparing', 'recording')).toBe(true);
    expect(canTransition('recording', 'merging')).toBe(true);
    expect(canTransition('recording', 'completed')).toBe(true);
    expect(canTransition('recording', 'downloading')).toBe(false);
    expect(isActive({ stage: 'recording' })).toBe(true);
    expect(canStop({ stage: 'recording' })).toBe(true);
    for (const s of ['detected', 'preparing', 'downloading', 'merging', 'completed', 'failed', 'cancelled'])
      expect(canStop({ stage: s as JobStage })).toBe(false);
  });
});

describe('live recording stages', () => {
  it('a live recording is recorded, then joined', () => {
    expect(stagesFor(plan({ pipeline: 'live', requiresFfmpeg: true }))).toEqual([
      'detected',
      'preparing',
      'recording',
      'merging',
      'completed',
    ]);
  });
});

describe('stagesFor: only the stages a job really passes through', () => {
  it('native', () =>
    expect(stagesFor(plan())).toEqual(['detected', 'preparing', 'downloading', 'completed']));
  it('copy-merge', () =>
    expect(stagesFor(plan({ requiresFfmpeg: true, pipeline: 'hls-ffmpeg-copy' }))).toEqual([
      'detected',
      'preparing',
      'downloading',
      'merging',
      'completed',
    ]));
  it('transcode', () =>
    expect(
      stagesFor(plan({ requiresFfmpeg: true, pipeline: 'ffmpeg-transcode', audio: 'transcode' })),
    ).toEqual(['detected', 'preparing', 'downloading', 'encoding', 'completed']));
});

describe('transitions', () => {
  const job0 = () => createJob('j1', request, plan(), 1000);

  it('walks the happy path', () => {
    let j = job0();
    for (const s of ['preparing', 'downloading', 'completed'] as const) j = transition(j, s, 2000);
    expect(j.stage).toBe('completed');
    expect(j.finishedAt).toBe(2000);
    expect(j.progress.fraction).toBe(1);
  });
  it('rejects illegal moves', () => {
    expect(() => transition(job0(), 'completed', 1)).toThrow(IllegalTransitionError);
    expect(() => transition(job0(), 'downloading', 1)).toThrow(IllegalTransitionError);
  });
  it('terminal stages have no exits (retry is explicit)', () => {
    for (const t of ['completed', 'failed', 'cancelled'] as JobStage[]) {
      expect(TRANSITIONS[t]).toEqual([]);
      expect(canTransition(t, 'downloading')).toBe(false);
    }
  });
  it('every non-terminal stage can fail or be cancelled', () => {
    for (const s of [
      'detected',
      'preparing',
      'downloading',
      'recording',
      'merging',
      'encoding',
    ] as JobStage[]) {
      expect(canTransition(s, 'failed')).toBe(true);
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });
  it('records the error on failure and clears stale progress on new stages', () => {
    let j = transition(job0(), 'preparing', 2);
    j = transition(j, 'downloading', 3);
    j = withProgress(j, { fraction: 0.5, bytesDone: 5 }, 4);
    const failed = failJob(j, 5, { code: 'network', message: 'offline' });
    expect(failed).toMatchObject({ stage: 'failed', error: { code: 'network' }, finishedAt: 5 });
    expect(transition(j, 'merging', 6).progress).toEqual({});
  });
  it('failJob is a no-op on a finished job', () => {
    const done = transition(transition(transition(job0(), 'preparing', 1), 'downloading', 2), 'completed', 3);
    expect(failJob(done, 4, { code: 'unknown', message: 'x' })).toBe(done);
  });
  it('identifies active jobs', () => {
    expect(isActive(job0())).toBe(false);
    expect(isActive(transition(job0(), 'preparing', 1))).toBe(true);
  });
});

describe('retry', () => {
  it('resets a failed job for another attempt', () => {
    let j = transition(createJob('j', request, plan(), 1), 'preparing', 2);
    j = failJob(j, 3, { code: 'http-error', message: '403' });
    j = { ...j, chromeDownloadId: 9, filePath: '/x' };
    expect(canRetry(j)).toBe(true);
    const r = retryJob(j, 10);
    expect(r).toMatchObject({ stage: 'detected', attempts: 1, progress: {} });
    expect(r.error).toBeUndefined();
    expect(r.chromeDownloadId).toBeUndefined();
    expect(r.finishedAt).toBeUndefined();
  });
  it('can retry cancelled jobs but not completed or running ones', () => {
    const base = createJob('j', request, plan(), 1);
    expect(canRetry(transition(base, 'cancelled', 2))).toBe(true);
    expect(() => retryJob(base, 2)).toThrow(IllegalTransitionError);
  });
});

describe('createJob', () => {
  it('only native jobs can pause', () => {
    expect(createJob('a', request, plan(), 1).canPause).toBe(true);
    expect(createJob('b', request, plan({ pipeline: 'hls-concat' }), 1).canPause).toBe(false);
  });
});

describe('SpeedMeter', () => {
  it('reports nothing until it has enough samples', () => {
    const m = new SpeedMeter();
    m.update(0, 0);
    m.update(1000, 500);
    expect(m.bytesPerSecond).toBeUndefined();
    expect(m.etaSeconds(1000)).toBeUndefined();
  });
  it('reports a smoothed rate and an ETA once stable', () => {
    const m = new SpeedMeter();
    for (let i = 0; i <= 6; i++) m.update(i * 1000, i * 500);
    expect(m.bytesPerSecond).toBeCloseTo(2000, 0);
    expect(m.etaSeconds(10_000)).toBeCloseTo(5, 0);
  });
  it('gives no ETA when the total is unknown or the rate is zero', () => {
    const m = new SpeedMeter();
    for (let i = 0; i <= 6; i++) m.update(0, i * 500);
    expect(m.etaSeconds(100)).toBeUndefined();
    expect(m.etaSeconds(undefined)).toBeUndefined();
  });
});

describe('restage: a refused native download is handed to the extension once', () => {
  const withReplay = {
    ...request,
    replay: { frameUrl: 'https://embed.example/p', urls: [request.sourceUrl] },
  };
  const downloading = (req = withReplay) =>
    transition(transition(createJob('j', req, plan(), 1), 'preparing', 2), 'downloading', 3);

  it('applies to 401/403 on a frame-owned plain file, nothing else', async () => {
    const { canRestage } = await import('@/lib/queue');
    expect(canRestage(downloading(), 'SERVER_FORBIDDEN')).toBe(true);
    expect(canRestage(downloading(), 'SERVER_UNAUTHORIZED')).toBe(true);
    expect(canRestage(downloading(), 'NETWORK_FAILED')).toBe(false);
    expect(canRestage(downloading(), 'USER_CANCELED')).toBe(false);
    expect(canRestage(downloading(), undefined)).toBe(false);
    expect(canRestage(downloading({ ...request } as typeof withReplay), 'SERVER_FORBIDDEN')).toBe(false); // no frame known
    expect(canRestage(downloading({ ...withReplay, isHls: true }), 'SERVER_FORBIDDEN')).toBe(false);
  });
  it('goes back to PREPARING owned by the offscreen pipeline, cannot pause, and only happens once', async () => {
    const { restage, canRestage } = await import('@/lib/queue');
    const j = restage({ ...downloading(), chromeDownloadId: 9, canPause: true }, 10);
    expect(j).toMatchObject({
      stage: 'preparing',
      staged: true,
      viaOffscreen: true,
      canPause: false,
      progress: {},
    });
    expect(j.chromeDownloadId).toBeUndefined();
    expect(canRestage({ ...j, stage: 'downloading' }, 'SERVER_FORBIDDEN')).toBe(false);
    expect(() => restage({ ...j, stage: 'downloading' }, 11)).toThrow(IllegalTransitionError);
    expect(() => restage(createJob('x', withReplay, plan(), 1), 11)).toThrow(IllegalTransitionError);
  });
});
