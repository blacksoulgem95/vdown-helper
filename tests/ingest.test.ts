import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestDown, IngestUp } from '@/types/ingest';

const written: Uint8Array[] = [];
let aborted = false;
vi.mock('@/offscreen/opfs', () => ({
  purgeAll: async () => undefined,
  createStageFile: async () => ({
    bytes: 0,
    write: async (c: Uint8Array) => void written.push(c),
    finish: async () => new File([new Blob(written as BlobPart[])], 'source.bin'),
    abort: async () => void (aborted = true),
  }),
}));

import { expectIngest, expectRecording, handleIngestPort } from '@/offscreen/ingest';

class FakePort {
  sent: IngestDown[] = [];
  disconnected = false;
  private listeners: Array<(m: IngestUp) => void> = [];
  private onDisc: Array<() => void> = [];
  onMessage = { addListener: (f: (m: IngestUp) => void) => void this.listeners.push(f) };
  onDisconnect = { addListener: (f: () => void) => void this.onDisc.push(f) };
  constructor(
    public name: string,
    public sender: { id?: string; tab?: { id: number }; frameId?: number },
  ) {}
  postMessage(m: IngestDown) {
    this.sent.push(m);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** What the content script does. */
  say(m: IngestUp) {
    for (const l of this.listeners) l(m);
  }
  drop() {
    for (const l of this.onDisc) l();
  }
}

const b64 = (s: string) => btoa(s);
const flush = () => new Promise((r) => setTimeout(r, 0));
const ME = 'ext-id';

beforeEach(() => {
  written.length = 0;
  aborted = false;
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id: ME } };
});
afterEach(() => vi.useRealTimers());

function expecting(over: Partial<Parameters<typeof expectIngest>[0]> = {}) {
  const ac = new AbortController();
  const progress: Array<[number, number]> = [];
  const p = expectIngest({
    jobId: 'job1',
    tabId: 7,
    frameId: 2,
    fileName: 'source.bin',
    signal: ac.signal,
    onProgress: (b, t) => progress.push([b, t]),
    ...over,
  });
  return { p, ac, progress };
}
const good = () => new FakePort('vdh-ingest:job1', { id: ME, tab: { id: 7 }, frameId: 2 });

describe('page-held bytes (offscreen side)', () => {
  it('receives acknowledged chunks in order and returns the file', async () => {
    const { p, progress } = expecting();
    const port = good();
    handleIngestPort(port as unknown as chrome.runtime.Port);
    expect(port.sent).toEqual([{ t: 'ready' }]);
    port.say({ t: 'begin', mime: 'video/mp4', total: 6 });
    port.say({ t: 'chunk', seq: 0, b64: b64('abc') });
    port.say({ t: 'chunk', seq: 1, b64: b64('def') });
    port.say({ t: 'end', chunks: 2 });
    const r = await p;
    expect(r.bytes).toBe(6);
    expect(r.mime).toBe('video/mp4');
    expect(await r.file.text()).toBe('abcdef');
    expect(port.sent).toEqual([{ t: 'ready' }, { t: 'ack', seq: 0 }, { t: 'ack', seq: 1 }, { t: 'done' }]);
    expect(progress).toEqual([
      [3, 6],
      [6, 6],
    ]);
  });

  it.each([
    ['another extension', { id: 'other', tab: { id: 7 }, frameId: 2 }],
    ['a page of the extension itself (no tab)', { id: ME }],
    ['a different tab', { id: ME, tab: { id: 8 }, frameId: 2 }],
    ['a different frame', { id: ME, tab: { id: 7 }, frameId: 0 }],
  ])('refuses a connection from %s', async (_n, sender) => {
    const { p } = expecting();
    const port = new FakePort('vdh-ingest:job1', sender);
    handleIngestPort(port as unknown as chrome.runtime.Port);
    expect(port.sent[0]).toMatchObject({ t: 'abort' });
    expect(port.disconnected).toBe(true);
    // the real one can still connect afterwards
    const ok = good();
    handleIngestPort(ok as unknown as chrome.runtime.Port);
    ok.say({ t: 'begin', mime: 'a/b', total: 0 });
    ok.say({ t: 'end', chunks: 0 });
    expect((await p).bytes).toBe(0);
  });

  it('refuses a job nobody is waiting for, and a second connection for the same job', async () => {
    const stranger = new FakePort('vdh-ingest:nope', { id: ME, tab: { id: 7 }, frameId: 2 });
    handleIngestPort(stranger as unknown as chrome.runtime.Port);
    expect(stranger.sent[0]).toMatchObject({ t: 'abort' });

    const { p } = expecting();
    p.catch(() => undefined);
    handleIngestPort(good() as unknown as chrome.runtime.Port);
    const second = good();
    handleIngestPort(second as unknown as chrome.runtime.Port);
    expect(second.sent[0]).toMatchObject({ t: 'abort' });
  });

  it('refuses data larger than allowed, announced or actually sent', async () => {
    const a = expecting({ maxBytes: 4 });
    a.p.catch(() => undefined);
    const pa = good();
    handleIngestPort(pa as unknown as chrome.runtime.Port);
    pa.say({ t: 'begin', mime: 'a/b', total: 5 });
    await expect(a.p).rejects.toMatchObject({ code: 'too-large' });
    expect(pa.sent.at(-1)).toMatchObject({ t: 'abort' });

    const b = expecting();
    b.p.catch(() => undefined);
    const pb = good();
    handleIngestPort(pb as unknown as chrome.runtime.Port);
    pb.say({ t: 'begin', mime: 'a/b', total: 2 });
    pb.say({ t: 'chunk', seq: 0, b64: b64('toolong') }); // more than it announced
    await expect(b.p).rejects.toMatchObject({ code: 'too-large' });
    expect(aborted).toBe(true);
  });

  it.each([
    [
      'chunks out of order',
      [
        { t: 'begin', mime: 'a/b', total: 6 },
        { t: 'chunk', seq: 1, b64: 'AAAA' },
      ] as IngestUp[],
    ],
    ['a chunk before begin', [{ t: 'chunk', seq: 0, b64: 'AAAA' }] as IngestUp[]],
    [
      'an end that does not add up',
      [
        { t: 'begin', mime: 'a/b', total: 6 },
        { t: 'chunk', seq: 0, b64: b64('abc') },
        { t: 'end', chunks: 1 },
      ] as IngestUp[],
    ],
    ['a page error', [{ t: 'error', message: 'x' }] as IngestUp[]],
    ['a negative size', [{ t: 'begin', mime: 'a/b', total: -1 }] as IngestUp[]],
  ])('fails cleanly on %s', async (_n, script) => {
    const { p } = expecting();
    p.catch(() => undefined);
    const port = good();
    handleIngestPort(port as unknown as chrome.runtime.Port);
    for (const m of script) port.say(m);
    await expect(p).rejects.toBeInstanceOf(Error);
    expect(port.disconnected).toBe(true);
  });

  it('fails when the page disconnects mid-transfer, and when the job is cancelled', async () => {
    const a = expecting();
    a.p.catch(() => undefined);
    const pa = good();
    handleIngestPort(pa as unknown as chrome.runtime.Port);
    pa.say({ t: 'begin', mime: 'a/b', total: 6 });
    await flush();
    pa.drop();
    await expect(a.p).rejects.toMatchObject({ code: 'network' });

    const b = expecting();
    b.p.catch(() => undefined);
    const pb = good();
    handleIngestPort(pb as unknown as chrome.runtime.Port);
    b.ac.abort();
    await expect(b.p).rejects.toMatchObject({ name: 'CancelledError' });
    expect(pb.disconnected).toBe(true);
  });

  it('gives up when the page never connects', async () => {
    vi.useFakeTimers();
    const { p } = expecting();
    const caught = expect(p).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(21_000);
    await caught;
  });
});

describe('recording a MediaStream (offscreen side)', () => {
  function recording(over: Partial<Parameters<typeof expectRecording>[0]> = {}) {
    const ac = new AbortController();
    const started = vi.fn();
    const progress: number[] = [];
    const p = expectRecording({
      jobId: 'job1',
      tabId: 7,
      frameId: 2,
      maxBytes: 100,
      signal: ac.signal,
      onStart: started,
      onProgress: (b) => progress.push(b),
      ...over,
    });
    p.catch(() => undefined);
    return { p, ac, started, progress };
  }
  const chunk = (seq: number, s: string): IngestUp => ({ t: 'cchunk', seq, track: '0', b64: b64(s) });

  it('stages the recorder output in order and returns it with its type once the page says it is done', async () => {
    const { p, started, progress } = recording();
    const port = good();
    handleIngestPort(port as unknown as chrome.runtime.Port);
    port.say({ t: 'cbegin', mime: 'video/webm;codecs=vp9,opus' });
    await flush();
    expect(started).toHaveBeenCalledTimes(1);
    port.say(chunk(0, 'abc'));
    port.say(chunk(1, 'defg'));
    port.say({ t: 'cend', chunks: 2 });
    const r = await p;
    expect(r).toMatchObject({ bytes: 7, mime: 'video/webm;codecs=vp9,opus', partial: false });
    expect(await r.file.text()).toBe('abcdefg');
    expect(port.sent).toEqual([{ t: 'ready' }, { t: 'ack', seq: 0 }, { t: 'ack', seq: 1 }, { t: 'done' }]);
    expect(progress).toEqual([3, 7]);
  });

  it('refuses a type the recorder never writes, out-of-order data and more than the hard limit', async () => {
    for (const bad of [
      (port: FakePort) => port.say({ t: 'cbegin', mime: 'text/html' }),
      (port: FakePort) => port.say({ t: 'cbegin' }),
      (port: FakePort) => {
        port.say({ t: 'cbegin', mime: 'video/webm' });
        port.say(chunk(1, 'x'));
      },
      (port: FakePort) => {
        port.say({ t: 'cbegin', mime: 'video/webm' });
        port.say(chunk(0, 'x'.repeat(101)));
      },
    ]) {
      const { p } = recording();
      const port = good();
      handleIngestPort(port as unknown as chrome.runtime.Port);
      bad(port);
      await expect(p).rejects.toBeTruthy();
      expect(port.sent.at(-1)).toMatchObject({ t: 'abort' });
    }
  });

  it('keeps what had arrived when the tab goes away (closed or navigated), and fails when nothing had', async () => {
    const kept = recording();
    const port = good();
    handleIngestPort(port as unknown as chrome.runtime.Port);
    port.say({ t: 'cbegin', mime: 'audio/webm' });
    port.say(chunk(0, 'abc'));
    port.drop();
    const r = await kept.p;
    expect(r).toMatchObject({ bytes: 3, partial: true });
    expect(await r.file.text()).toBe('abc');

    written.length = 0;
    const empty = recording();
    const port2 = good();
    handleIngestPort(port2 as unknown as chrome.runtime.Port);
    port2.say({ t: 'cbegin', mime: 'audio/webm' });
    port2.drop();
    await expect(empty.p).rejects.toBeTruthy();
  });

  it('treats the page reporting "cancelled" as a cancellation, and any other page error as a failure', async () => {
    const { CancelledError } = await import('@/offscreen/errors');
    const a = recording();
    const pa = good();
    handleIngestPort(pa as unknown as chrome.runtime.Port);
    pa.say({ t: 'cbegin', mime: 'video/webm' });
    pa.say({ t: 'error', message: 'cancelled' });
    await expect(a.p).rejects.toBeInstanceOf(CancelledError);

    const b = recording();
    const pb = good();
    handleIngestPort(pb as unknown as chrome.runtime.Port);
    pb.say({ t: 'cbegin', mime: 'video/webm' });
    pb.say({ t: 'error', message: 'boom' });
    await expect(b.p).rejects.not.toBeInstanceOf(CancelledError);
  });

  it('is cancelled by the job, and never starts for an unexpected sender', async () => {
    const { p, ac } = recording();
    const stranger = new FakePort('vdh-ingest:job1', { id: ME, tab: { id: 99 }, frameId: 2 });
    handleIngestPort(stranger as unknown as chrome.runtime.Port);
    expect(stranger.sent[0]).toMatchObject({ t: 'abort' });
    ac.abort();
    const { CancelledError } = await import('@/offscreen/errors');
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });
});
