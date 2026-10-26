import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HlsSegment } from '@/types/hls';

const staged: Uint8Array[] = [];
let aborted = false;
vi.mock('@/offscreen/opfs', () => ({
  freeBytes: async () => undefined,
  createStageFile: async () => ({
    get bytes() {
      return staged.reduce((n, c) => n + c.byteLength, 0);
    },
    write: async (c: Uint8Array) => void staged.push(c),
    finish: async () => new File([new Blob(staged as BlobPart[])], 'live.ts'),
    abort: async () => void (aborted = true),
  }),
}));

import { recordLiveTrack, type LivePoll } from '@/offscreen/live';
import { CancelledError } from '@/offscreen/errors';

const seg = (n: number, duration = 2): HlsSegment => ({
  uri: `https://cdn.example/seg${n}.ts`,
  duration,
  sequence: n,
  discontinuity: false,
});
const poll = (nums: number[], over: Partial<LivePoll> = {}): LivePoll => ({
  segments: nums.map((n) => seg(n)),
  ended: false,
  refreshSec: 0.01,
  sequenced: true,
  fragmented: false,
  ...over,
});

const realFetch = globalThis.fetch;
let missing = new Set<string>();
beforeEach(() => {
  staged.length = 0;
  aborted = false;
  missing = new Set();
  globalThis.fetch = (async (url: string) => {
    if (missing.has(url)) return new Response('gone', { status: 404 });
    const n = /seg(\d+)\.ts/.exec(url)?.[1] ?? '?';
    return new Response(new Uint8Array([Number(n), Number(n), Number(n)]));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function options(source: () => Promise<LivePoll>, over: Record<string, unknown> = {}) {
  const cancel = new AbortController();
  const stop = new AbortController();
  return {
    cancel,
    stop,
    run: () =>
      recordLiveTrack({
        jobId: 'j',
        fileName: (f) => (f ? 'v.mp4' : 'v.ts'),
        source,
        concurrency: 2,
        credentialedOrigins: [],
        signal: cancel.signal,
        stop: stop.signal,
        onLimit: () => stop.abort(),
        maxSeconds: 3600,
        maxBytes: 1e9,
        onProgress: () => undefined,
        ...over,
      }),
  };
}
const order = () => staged.map((c) => c[0]);

describe('live recording (one track)', () => {
  it('appends every segment once, in order, as the playlist slides, and ends with the stream', async () => {
    const polls = [poll([0, 1, 2]), poll([1, 2, 3]), poll([1, 2, 3]), poll([2, 3, 4], { ended: true })];
    const o = options(async () => polls.shift() as LivePoll);
    const r = await o.run();
    expect(order()).toEqual([0, 1, 2, 3, 4]);
    expect(r).toMatchObject({ endedBy: 'ended', seconds: 10, gaps: 0, fragmented: false });
    expect(r.bytes).toBe(15);
  });

  it('counts the segments that went by between two looks as a gap, and a segment the server dropped too', async () => {
    missing.add('https://cdn.example/seg1.ts');
    const polls = [poll([0, 1, 2]), poll([6, 7], { ended: true })]; // 3,4,5 were never seen
    const r = await options(async () => polls.shift() as LivePoll).run();
    expect(order()).toEqual([0, 2, 6, 7]);
    expect(r.gaps).toBe(3 + 1);
  });

  it('stops when told to, keeps what it has, and does not wait for the next look', async () => {
    let looks = 0;
    const o = options(async () => poll([looks++, looks]), {});
    const done = o.run();
    setTimeout(() => o.stop.abort(), 60);
    const r = await done;
    expect(r.endedBy).toBe('user');
    expect(r.bytes).toBeGreaterThan(0);
    expect(aborted).toBe(false);
  });

  it('ends by itself at the time limit and at the size limit, and tells the other tracks', async () => {
    let n = 0;
    const onLimit = vi.fn();
    const time = await options(async () => poll([n++, n++]), { maxSeconds: 5, onLimit }).run();
    expect(time.endedBy).toBe('limit');
    expect(time.seconds).toBeGreaterThanOrEqual(5);
    expect(onLimit).toHaveBeenCalled();
    staged.length = 0;
    n = 100;
    const size = await options(async () => poll([n++, n++]), { maxBytes: 10 }).run();
    expect(size.endedBy).toBe('limit');
    expect(size.bytes).toBeGreaterThanOrEqual(10);
  });

  it('gives up on a stream that stops moving, keeping what was recorded', async () => {
    vi.useFakeTimers();
    let first = true;
    const run = options(async () => {
      const p = first ? poll([0, 1], { refreshSec: 10 }) : poll([0, 1], { refreshSec: 10 });
      first = false;
      return p;
    }).run();
    await vi.advanceTimersByTimeAsync(120_000);
    const r = await run;
    vi.useRealTimers();
    expect(r.endedBy).toBe('stalled');
    expect(order()).toEqual([0, 1]);
  });

  it('gives up when every new segment is gone, keeping what was recorded before', async () => {
    vi.useFakeTimers();
    let n = 0;
    const run = options(async () => {
      if (n >= 2) for (let k = n; k < n + 2; k++) missing.add(`https://cdn.example/seg${k}.ts`);
      const p = poll([n, n + 1], { refreshSec: 2 });
      n += 2;
      return p;
    }).run();
    await vi.advanceTimersByTimeAsync(200_000);
    const r = await run;
    vi.useRealTimers();
    expect(r.endedBy).toBe('stalled');
    expect(order()).toEqual([0, 1]);
    expect(r.gaps).toBeGreaterThan(0);
  });

  it('fails when the stream cannot be read at all, and keeps going through short outages', async () => {
    const down = options(async () => {
      throw new Error('offline');
    });
    vi.useFakeTimers();
    const failing = down.run();
    failing.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20000);
    await expect(failing).rejects.toThrow('offline');
    vi.useRealTimers();

    let calls = 0;
    const polls = [poll([0]), poll([1], { ended: true })];
    const flaky = await options(async () => {
      if (calls++ === 1) throw new Error('blip');
      return polls.shift() as LivePoll;
    }).run();
    // the first look worked, the second failed, the third and fourth worked
    expect(flaky.endedBy).toBe('ended');
  }, 15000);

  it('is cancelled by the job: nothing is kept', async () => {
    const o = options(async () => poll([0, 1]));
    const done = o.run();
    setTimeout(() => o.cancel.abort(), 40);
    await expect(done).rejects.toBeInstanceOf(CancelledError);
    expect(aborted).toBe(true);
  });
});
