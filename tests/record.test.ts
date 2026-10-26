import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeStream, recorderMime, streamMedia, streamOf } from '@/content/capture';
import { scan } from '@/content/scanner';
import { recordingExtension } from '@/offscreen/jobs';

const track = (kind: 'audio' | 'video', readyState: 'live' | 'ended' = 'live') => ({
  kind,
  readyState,
  getSettings: () => (kind === 'video' ? { width: 640, height: 360 } : {}),
});
const fakeStream = (...tracks: ReturnType<typeof track>[]) => ({ getTracks: () => tracks });

function video(stream: unknown, attrs = ''): HTMLVideoElement {
  document.body.innerHTML = `<video ${attrs}></video>`;
  const el = document.querySelector('video') as HTMLVideoElement;
  Object.defineProperty(el, 'srcObject', { value: stream, configurable: true });
  return el;
}

describe('MediaStream detection', () => {
  it('describes a live stream by what it carries, with a stable handle', () => {
    const s = fakeStream(track('video'), track('audio'));
    const el = video(s);
    const a = describeStream(el);
    expect(a).toMatchObject({ hasVideo: true, width: 640, height: 360 });
    expect(a?.handle).toMatch(/^[0-9a-f]{8}$/);
    expect(describeStream(el)?.handle).toBe(a?.handle); // the same stream keeps its handle between scans
    expect(describeStream(video(fakeStream(track('audio'))))).toMatchObject({ hasVideo: false });
  });

  it('ignores streams that have ended and elements that play something else', () => {
    expect(describeStream(video(fakeStream(track('video', 'ended'))))).toBeUndefined();
    expect(describeStream(video(null))).toBeUndefined();
    expect(describeStream(video({ notAStream: true }))).toBeUndefined();
    expect(streamOf(video('blob:x' as unknown))).toBeUndefined();
  });

  it('is listed by a scan as a recordable stream with a label instead of an address', () => {
    video(fakeStream(track('video')), 'title="Webcam"');
    const r = scan();
    const c = r.candidates.find((x) => x.held?.kind === 'stream');
    expect(c).toMatchObject({ mediaType: 'video', width: 640, height: 360, method: 'dom-element' });
    expect(c?.url).toMatch(/^data:application\/x-vdh-stream;vdh=[0-9a-f]{8}$/);
    expect(streamMedia.get(c!.held!.id)).toBe(document.querySelector('video'));
    expect(JSON.stringify(r)).not.toContain('blob:');
  });
});

describe('recorder type', () => {
  const real = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const support = (types: string[]) => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {
      isTypeSupported: (t: string) => types.includes(t),
    };
  };
  beforeEach(() => support([]));
  afterEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = real;
    vi.restoreAllMocks();
  });

  it('prefers WebM unless MP4 was asked for and is supported natively', () => {
    support(['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']);
    expect(recorderMime(true, 'webm')).toBe('video/webm;codecs=vp9,opus');
    expect(recorderMime(true, 'mp4')).toBe('video/mp4');
  });

  it('falls back to WebM when MP4 is not available, and to MP4 when WebM is not', () => {
    support(['video/webm']);
    expect(recorderMime(true, 'mp4')).toBe('video/webm');
    support(['video/mp4']);
    expect(recorderMime(true, 'webm')).toBe('video/mp4');
  });

  it('uses audio types for a stream without video, and reports when nothing fits', () => {
    support(['audio/webm;codecs=opus', 'video/webm']);
    expect(recorderMime(false, 'webm')).toBe('audio/webm;codecs=opus');
    support([]);
    expect(recorderMime(true, 'webm')).toBeUndefined();
  });

  it('names the file after what was recorded', () => {
    expect(recordingExtension('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(recordingExtension('audio/webm')).toBe('webm');
    expect(recordingExtension('video/mp4;codecs=avc1.42e01e,mp4a.40.2')).toBe('mp4');
    expect(recordingExtension('audio/mp4')).toBe('m4a');
  });
});

describe('startRecord (page side), with a fake recorder', () => {
  class FakeRecorder {
    static supported = ['video/webm'];
    static isTypeSupported = (t: string) => FakeRecorder.supported.includes(t);
    static last: FakeRecorder | undefined;
    state: 'inactive' | 'recording' = 'inactive';
    private on = new Map<string, Array<(e: unknown) => void>>();
    constructor(
      public stream: unknown,
      public opts: { mimeType: string },
    ) {
      FakeRecorder.last = this;
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      this.on.set(type, [...(this.on.get(type) ?? []), fn]);
    }
    emit(type: string, e: unknown = {}) {
      for (const f of this.on.get(type) ?? []) f(e);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => this.emit('stop'));
    }
    data(size: number) {
      this.emit('dataavailable', { data: new Blob([new Uint8Array(size)]) });
    }
  }

  const sent: unknown[] = [];
  let reply: (m: unknown) => void = () => undefined;
  const realRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const labels = { title: 't', cancel: 'Cancel', stop: 'Stop', progress: '$1' };

  beforeEach(() => {
    sent.length = 0;
    FakeRecorder.supported = ['video/webm'];
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
    const w = globalThis as unknown as { chrome: unknown };
    w.chrome = {
      runtime: {
        connect: () => {
          let onMsg: (m: unknown) => void = () => undefined;
          reply = (m) => onMsg(m);
          return {
            onMessage: { addListener: (f: (m: unknown) => void) => (onMsg = f) },
            onDisconnect: { addListener: () => undefined },
            postMessage: (m: { t: string }) => {
              sent.push(m);
              if (m.t === 'cchunk') queueMicrotask(() => onMsg({ t: 'ack' }));
              if (m.t === 'cend') queueMicrotask(() => onMsg({ t: 'done' }));
            },
            disconnect: () => undefined,
          };
        },
      },
    };
  });
  afterEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = realRecorder;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  async function begin(maxBytes = 1000, maxSeconds = 3600) {
    const { startRecord } = await import('@/content/capture');
    const el = video(fakeStream(track('video')));
    const d = describeStream(el)!;
    streamMedia.set(d.handle, el);
    const done = startRecord('job', d.handle, { prefer: 'webm', maxSeconds, maxBytes }, labels);
    await flush();
    reply({ t: 'ready' });
    await flush();
    return { done, rec: FakeRecorder.last! };
  }

  it('announces the type it chose, streams the pieces in order and ends with the count when stopped', async () => {
    const { done, rec } = await begin();
    expect(sent[0]).toEqual({ t: 'cbegin', mime: 'video/webm' });
    rec.data(100);
    rec.data(50);
    await flush();
    const { finishRecording } = await import('@/content/capture');
    expect(finishRecording('job')).toBe(true);
    const r = await done;
    expect(r).toMatchObject({ ok: true, bytes: 150, endedBy: 'user', mime: 'video/webm' });
    expect(
      sent.filter((m) => (m as { t: string }).t === 'cchunk').map((m) => (m as { seq: number }).seq),
    ).toEqual([0, 1]);
    expect(sent.at(-1)).toEqual({ t: 'cend', chunks: 2 });
    expect(document.querySelector('[data-vdown-banner]')).toBeNull();
  });

  it('stops by itself when the size limit is reached, and still hands over what it has', async () => {
    const { done, rec } = await begin(120);
    rec.data(100);
    await flush();
    expect(rec.state).toBe('recording');
    rec.data(30); // 130 >= 120
    const r = await done;
    expect(r).toMatchObject({ ok: true, bytes: 130, endedBy: 'limit' });
    expect(rec.state).toBe('inactive');
  });

  it('stops by itself when the time limit is reached', async () => {
    vi.useFakeTimers();
    const { startRecord } = await import('@/content/capture');
    const el = video(fakeStream(track('video')));
    const d = describeStream(el)!;
    streamMedia.set(d.handle, el);
    const done = startRecord('job', d.handle, { prefer: 'webm', maxSeconds: 2, maxBytes: 1e9 }, labels);
    await vi.advanceTimersByTimeAsync(10);
    reply({ t: 'ready' });
    await vi.advanceTimersByTimeAsync(10);
    const rec = FakeRecorder.last!;
    rec.data(10);
    await vi.advanceTimersByTimeAsync(2600);
    const r = await done;
    expect(r).toMatchObject({ ok: true, endedBy: 'limit' });
  });

  it('discards on cancel: reports "cancelled" to the extension and sends no end', async () => {
    const { done, rec } = await begin();
    rec.data(10);
    await flush();
    const { stopCapture } = await import('@/content/capture');
    expect(stopCapture('job')).toBe(true);
    const r = await done;
    expect(r).toMatchObject({ ok: false, code: 'cancelled' });
    expect(sent.at(-1)).toEqual({ t: 'error', message: 'cancelled' });
    expect(sent.some((m) => (m as { t: string }).t === 'cend')).toBe(false);
  });

  it('fails when the recorder produced nothing', async () => {
    const { done, rec } = await begin();
    rec.stop();
    const r = await done;
    expect(r).toMatchObject({ ok: false, code: 'failed' });
  });

  it('refuses when this browser cannot record the type, when the stream ended, and for protected playback', async () => {
    const { startRecord } = await import('@/content/capture');
    FakeRecorder.supported = [];
    const el = video(fakeStream(track('video')));
    const d = describeStream(el)!;
    streamMedia.set(d.handle, el);
    expect(
      await startRecord('j', d.handle, { prefer: 'webm', maxSeconds: 1, maxBytes: 1 }, labels),
    ).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    FakeRecorder.supported = ['video/webm'];
    expect(
      await startRecord('j', 'unknown1', { prefer: 'webm', maxSeconds: 1, maxBytes: 1 }, labels),
    ).toMatchObject({
      ok: false,
      code: 'no-source',
    });
    // an element with protected playback is not even offered
    const protectedEl = video(fakeStream(track('video')));
    Object.defineProperty(protectedEl, 'mediaKeys', { value: {} });
    expect(describeStream(protectedEl)).toBeUndefined();
  });
});
