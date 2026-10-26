import { describe, expect, it } from 'vitest';
import { cardHeadline, jobErrorText } from '@/components/labels';
import { popupQueue } from '@/lib/queue';
import { bestMatch, rankResources } from '@/lib/resources';
import { emptyCause } from '@/lib/tabs';
import type { DownloadJob, JobStage } from '@/types/download';
import type { HlsVariant } from '@/types/hls';
import { makeResource } from './helpers';

const ok = { status: 'downloadable', reason: 'ok' } as const;
const variant = (height: number): HlsVariant =>
  ({ uri: `https://cdn.example/${height}.m3u8`, bandwidth: height * 1000, height }) as HlsVariant;

describe('rankResources / bestMatch (VDH-050)', () => {
  it('puts what one click can save first, then video, quality, length, the page itself, then detection order', () => {
    const refused = makeResource('https://a.example/drm.mpd', {
      height: 2160,
      downloadability: { status: 'protected', reason: 'drm' },
    });
    const capture = makeResource('https://a.example/mse', {
      height: 1080,
      downloadability: { status: 'downloadable', reason: 'ok', detail: 'mse-capturable' },
    });
    const audio = makeResource('https://a.example/a.mp3', { mediaType: 'audio', downloadability: ok });
    const small = makeResource('https://a.example/360.mp4', { height: 360, downloadability: ok });
    const master = makeResource('https://a.example/master.m3u8', {
      kind: 'hls-master',
      format: 'hls',
      variants: [variant(360), variant(1080)],
      downloadability: ok,
    });
    const embedded = makeResource('https://b.example/1080.mp4', {
      height: 1080,
      frameId: 4,
      downloadability: ok,
    });
    const longer = makeResource('https://a.example/long.mp4', {
      height: 1080,
      durationSec: 600,
      downloadability: ok,
    });
    const ranked = rankResources([refused, capture, audio, small, embedded, master, longer]);
    expect(ranked.map((r) => r.url)).toEqual([
      longer.url, // 1080p and the longest
      master.url, // 1080p through its best variant, on the page itself
      embedded.url, // 1080p, but in an embedded frame
      small.url,
      audio.url, // a real file, but audio
      capture.url, // capture comes after every real file
      refused.url, // refused last, whatever its quality
    ]);
    expect(bestMatch(ranked)).toBe(longer);
  });
  it('keeps detection order on ties and offers no best match without a choice or without anything savable', () => {
    const a = makeResource('https://a.example/a.mp4', { downloadability: ok });
    const b = makeResource('https://a.example/b.mp4', { downloadability: ok });
    expect(rankResources([a, b])).toEqual([a, b]);
    expect(bestMatch([a])).toBeUndefined();
    const refused = makeResource('https://a.example/c.mp4', {
      downloadability: { status: 'protected', reason: 'eme' },
    });
    expect(bestMatch(rankResources([refused, refused]))).toBeUndefined();
  });
});

describe('cardHeadline (VDH-050)', () => {
  it('leads with quality and merges the format into one phrase', () => {
    expect(
      cardHeadline(
        makeResource('https://a.example/master.m3u8', {
          kind: 'hls-master',
          format: 'hls',
          variants: [variant(360), variant(1080), variant(720)],
        }),
      ),
    ).toBe('1080p · HLS · 3 qualities');
    expect(cardHeadline(makeResource('https://a.example/x.mp4', { height: 720 }))).toBe('720p · MP4');
  });
  it('never prints unknowns', () => {
    const h = cardHeadline(makeResource('https://a.example/x', { format: 'unknown', kind: 'file' }));
    expect(h).not.toContain('?');
    expect(h.length).toBeGreaterThan(0);
  });
  it('marks live streams', () => {
    expect(
      cardHeadline(
        makeResource('https://a.example/live.m3u8', {
          kind: 'hls-media',
          format: 'hls',
          downloadability: { status: 'downloadable', reason: 'ok', detail: 'live-recordable' },
        }),
      ),
    ).toBe('HLS · Live');
  });
});

describe('jobErrorText for Chrome interrupts (VDH-050)', () => {
  const failed = (message: string) =>
    ({ stage: 'failed', request: {}, error: { code: 'chrome-download', message } }) as unknown as DownloadJob;
  it('says what happened in words and keeps the code', () => {
    const text = jobErrorText(failed('SERVER_FORBIDDEN'));
    expect(text).toMatch(/refused/);
    expect(text).toContain('(SERVER_FORBIDDEN)');
  });
  it('keeps the generic wording for codes it does not know', () => {
    expect(jobErrorText(failed('SOMETHING_NEW'))).toBe('Chrome reported a download error (SOMETHING_NEW)');
  });
});

describe('popupQueue (VDH-050)', () => {
  const j = (stage: JobStage, n: number) => ({ stage, n });
  it('keeps every running or waiting job and only the latest finished ones', () => {
    const jobs = [
      j('downloading', 1),
      j('completed', 2),
      j('failed', 3),
      j('detected', 4),
      j('completed', 5),
      j('cancelled', 6),
      j('completed', 7),
    ];
    const { shown, hidden } = popupQueue(jobs);
    expect(shown.map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);
    expect(hidden).toBe(2);
    expect(popupQueue(jobs.slice(0, 2)).hidden).toBe(0);
  });
});

describe('emptyCause (VDH-050)', () => {
  it('picks the one fix to offer', () => {
    expect(emptyCause({ error: true, blockedFrames: 2, reloadPending: true })).toBe('error');
    expect(emptyCause({ error: false, blockedFrames: 2, reloadPending: true })).toBe('blocked-frames');
    expect(emptyCause({ error: false, blockedFrames: 0, reloadPending: true })).toBe('reload');
    expect(emptyCause({ error: false, blockedFrames: 0, reloadPending: false })).toBe('nothing');
  });
});
