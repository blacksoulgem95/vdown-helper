import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HlsSegment } from '@/types/hls';
import type { JobProgress } from '@/types/download';

vi.mock('@/offscreen/opfs', () => ({
  freeBytes: async () => undefined,
  createStageFile: async () => ({}),
  purgeAll: async () => undefined,
  removeJobDir: async () => undefined,
}));

import { writeSegments } from '@/offscreen/hls';
import { makeProgressSender } from '@/offscreen/jobs';

const seg = (n: number): HlsSegment => ({
  uri: `https://cdn.example/seg${n}.ts`,
  duration: 2,
  sequence: n,
  discontinuity: false,
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('final segment counters (VDH-048: the CI failure in runs 16, 20 and 24)', () => {
  it('never reports a flush that wrote nothing, and ends on n / n even when a later segment finishes first', async () => {
    // segment 0 is the slowest: segments 1 and 2 finish first and wait to be written in order
    globalThis.fetch = (async (url: string) => {
      const n = Number(/seg(\d+)/.exec(url)?.[1]);
      await new Promise((r) => setTimeout(r, n === 0 ? 60 : 5));
      return new Response(new Uint8Array([n]));
    }) as unknown as typeof fetch;
    const written: number[] = [];
    const reports: JobProgress[] = [];
    await writeSegments(
      {
        jobId: 'j',
        segs: [seg(0), seg(1), seg(2)],
        fragmented: false,
        durationSec: 6,
        concurrency: 3,
        signal: new AbortController().signal,
        onProgress: (p) => reports.push(p),
      },
      {
        write: async (d) => void written.push(d[0] as number),
        get bytes() {
          return written.length;
        },
      },
      { mapKey: '', skipped: 0 },
    );
    expect(written).toEqual([0, 1, 2]);
    expect(reports.map((p) => p.unitsDone)).toEqual([3]); // 1 and 2 waited for 0; then all three were written at once
    expect(reports.at(-1)).toMatchObject({ unitsDone: 3, unitsTotal: 3, fraction: 1 });
  });

  it('the job never throttles away the report that completes a stage', () => {
    const sent: JobProgress[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { sendMessage: async (ev: { progress: JobProgress }) => void sent.push(ev.progress) },
    };
    const send = makeProgressSender('job');
    send({ unitsDone: 1, unitsTotal: 3 });
    send({ unitsDone: 2, unitsTotal: 3 }); // within 250 ms: dropped
    send({ unitsDone: 3, unitsTotal: 3 }); // complete: always sent
    send({ fraction: 0.5 }); // dropped again
    send({ fraction: 1 }); // complete: sent
    expect(sent).toEqual([{ unitsDone: 1, unitsTotal: 3 }, { unitsDone: 3, unitsTotal: 3 }, { fraction: 1 }]);
  });
});
