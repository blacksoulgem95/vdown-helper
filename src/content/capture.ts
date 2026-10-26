/**
 * MSE capture controller (isolated world). When the user asks to capture a video that a player feeds through Media
 * Source Extensions and that has no manifest we could use, this records what the player appends to its SourceBuffers
 * (via the page hook, content/hook.ts) and streams it to the offscreen document, which assembles it into a file.
 *
 * To record everything the controller makes the player play the video through: it empties the SourceBuffers, rewinds,
 * mutes and (in fast mode) raises the playback rate. A banner says so, can cancel, and the video is put back as it
 * was: position, rate, volume and paused state. Nothing is recorded for a video that uses EME: that is protected
 * playback and is refused.
 */
import { INGEST_PORT_PREFIX, MAX_CAPTURE_TRACKS, type IngestDown, type IngestUp } from '@/types/ingest';

export interface BannerLabels {
  /** "vdown-helper is capturing this video" */
  title: string;
  cancel: string;
  /** "$1% (fast capture)" - the percentage is substituted */
  progress: string;
}

export type CaptureResult =
  | { ok: true; chunks: number; bytes: number }
  | {
      ok: false;
      code: 'protected' | 'live' | 'no-source' | 'no-hook' | 'cancelled' | 'stalled' | 'blocked' | 'failed';
      message: string;
    };

/** Videos the last scan found that are fed by a MediaSource (or whose blob: URL could not be read), by handle. */
export const mseVideos = new Map<string, HTMLMediaElement>();

const STALL_MS = 30_000;
const IDLE_END_MS = 1_800;
const QUEUE_PAUSE_BYTES = 64 * 1024 * 1024;
const QUEUE_RESUME_BYTES = 16 * 1024 * 1024;

const active = new Map<string, () => void>(); // jobId -> cancel

/** Ask a running capture to stop (the job was cancelled in the extension). */
export function stopCapture(jobId: string): boolean {
  const cancel = active.get(jobId);
  cancel?.();
  return cancel !== undefined;
}

function showBanner(labels: BannerLabels, onCancel: () => void) {
  const host = document.createElement('div');
  host.setAttribute('data-vdown-banner', '');
  host.style.cssText =
    'all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.style.cssText =
    'display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:10px;font:600 13px/1.3 system-ui,sans-serif;' +
    'color:#e8faff;background:#0b0f1e;border:1px solid #00f5ff;box-shadow:0 0 18px rgba(0,245,255,.35);';
  const title = document.createElement('span');
  title.textContent = labels.title;
  const progress = document.createElement('span');
  progress.style.cssText = 'color:#00f5ff;font-variant-numeric:tabular-nums;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = labels.cancel;
  cancel.style.cssText =
    'all:unset;cursor:pointer;padding:4px 10px;border-radius:6px;border:1px solid #ff2bd6;color:#ff2bd6;text-transform:uppercase;font-size:11px;letter-spacing:.08em;';
  cancel.addEventListener('click', onCancel);
  box.append(title, progress, cancel);
  root.append(box);
  document.documentElement.append(host);
  return {
    set(percent: number) {
      progress.textContent = labels.progress.replace(
        '$1',
        String(Math.max(0, Math.min(100, Math.round(percent)))),
      );
    },
    remove() {
      host.remove();
    },
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

interface Chunk {
  track: string;
  buf: ArrayBuffer;
}

export async function startCapture(
  jobId: string,
  handle: string,
  speed: 'fast' | 'realtime',
  labels: BannerLabels,
): Promise<CaptureResult> {
  const video = mseVideos.get(handle);
  if (!video || !video.isConnected || !/^blob:/i.test(video.currentSrc))
    return { ok: false, code: 'no-source', message: 'The video is no longer on the page' };
  // Protected playback is never recorded: what the player appends is encrypted, and decrypting it is not ours to do.
  if (video.mediaKeys) return { ok: false, code: 'protected', message: 'This video uses protected playback' };
  if (!Number.isFinite(video.duration) || video.duration <= 0)
    return { ok: false, code: 'live', message: 'Live streams cannot be captured yet' };

  let cancelled = false;
  let failure: CaptureResult | undefined;
  const cancel = () => {
    cancelled = true;
  };
  active.set(jobId, cancel);
  const banner = showBanner(labels, cancel);
  banner.set(0);

  const saved = {
    paused: video.paused,
    muted: video.muted,
    rate: video.playbackRate,
    time: video.currentTime,
    volume: video.volume,
  };
  const port = chrome.runtime.connect({ name: `${INGEST_PORT_PREFIX}${jobId}` });
  const inbox: IngestDown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  port.onMessage.addListener((m: IngestDown) => {
    inbox.push(m);
    wake?.();
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    wake?.();
  });
  const next = async (): Promise<IngestDown | undefined> => {
    while (inbox.length === 0 && !closed) await new Promise<void>((r) => (wake = r));
    return inbox.shift();
  };
  const expect = async (t: IngestDown['t']): Promise<void> => {
    const m = await next();
    if (!m) throw new Error('The extension closed the connection');
    if (m.t === 'abort') throw new Error(m.message);
    if (m.t !== t) throw new Error('Unexpected reply from the extension');
  };
  const send = (m: IngestUp) => port.postMessage(m);
  let phase = 'connect';

  // chunks from the page hook
  const queue: Chunk[] = [];
  let queued = 0;
  let sent = 0;
  let bytes = 0;
  let lastActivity = Date.now();
  let notify: (() => void) | undefined;
  const onMessage = (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const d = ev.data as { __vdh?: string; sb?: unknown; buf?: unknown } | null;
    if (!d || d.__vdh !== 'mse-chunk' || typeof d.sb !== 'string' || !(d.buf instanceof ArrayBuffer)) return;
    queue.push({ track: d.sb.slice(0, 20), buf: d.buf });
    queued += d.buf.byteLength;
    lastActivity = Date.now();
    notify?.();
  };
  window.addEventListener('message', onMessage);
  const onEncrypted = () => {
    failure = { ok: false, code: 'protected', message: 'This video uses protected playback' };
    cancelled = true;
  };
  video.addEventListener('encrypted', onEncrypted);

  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    video.removeEventListener('encrypted', onEncrypted);
    window.postMessage({ __vdh: 'mse-disarm' }, '*');
    try {
      video.pause();
      video.playbackRate = saved.rate;
      video.muted = saved.muted;
      video.volume = saved.volume;
      video.currentTime = saved.time;
      if (!saved.paused) void video.play().catch(() => undefined);
    } catch {
      // the element may be gone
    }
    banner.remove();
    active.delete(jobId);
    try {
      port.disconnect();
    } catch {
      // already closed
    }
  };

  try {
    await expect('ready');
    phase = 'begin';
    send({ t: 'cbegin' });
    phase = 'arm';

    // arm the hook: it empties the buffers and replays the initialisation segments
    const token = Math.random().toString(36).slice(2);
    const armed = await new Promise<{ ok: boolean; reason?: string; buffers?: unknown[] }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'no-hook' }), 4000);
      const on = (ev: MessageEvent) => {
        const d = ev.data as { __vdh?: string; token?: string } | null;
        if (ev.source !== window || d?.__vdh !== 'mse-armed' || d.token !== token) return;
        window.removeEventListener('message', on);
        clearTimeout(timer);
        resolve(d as unknown as { ok: boolean; reason?: string; buffers?: unknown[] });
      };
      window.addEventListener('message', on);
      window.postMessage({ __vdh: 'mse-arm', url: video.currentSrc, flush: true, token }, '*');
    });
    if (!armed.ok) {
      const code = armed.reason === 'live' ? 'live' : armed.reason === 'no-hook' ? 'no-hook' : 'no-source';
      throw Object.assign(new Error(`Cannot record this player (${armed.reason ?? 'unknown'})`), { code });
    }
    if ((armed.buffers?.length ?? 0) > MAX_CAPTURE_TRACKS) throw new Error('Too many tracks');

    phase = 'play';
    video.muted = true;
    video.currentTime = 0;
    video.playbackRate = speed === 'fast' ? 16 : 1;
    try {
      await video.play();
    } catch {
      throw Object.assign(new Error('The browser did not allow the video to play'), { code: 'blocked' });
    }

    phase = 'relay';
    // relay: send queued chunks one at a time, each acknowledged; pause playback if we fall behind
    let paused = false;
    let lastTime = video.currentTime;
    let lastProgress = Date.now();
    let reachedEnd = false;
    while (!cancelled) {
      const chunk = queue.shift();
      if (chunk) {
        queued -= chunk.buf.byteLength;
        bytes += chunk.buf.byteLength;
        send({
          t: 'cchunk',
          seq: sent,
          track: chunk.track,
          b64: await toBase64(new Blob([chunk.buf])),
          frac: Math.min(1, Math.max(0, video.currentTime / video.duration)),
        });
        await expect('ack');
        sent++;
      } else {
        if (reachedEnd && Date.now() - lastActivity > IDLE_END_MS) break;
        await Promise.race([new Promise<void>((r) => (notify = r)), wait(250)]);
      }
      if (!paused && queued > QUEUE_PAUSE_BYTES) {
        video.pause();
        paused = true;
      } else if (paused && queued < QUEUE_RESUME_BYTES) {
        void video.play().catch(() => undefined);
        paused = false;
      }
      banner.set((video.currentTime / video.duration) * 100);
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgress = Date.now();
      }
      if (video.ended || video.currentTime >= video.duration - 0.3) reachedEnd = true;
      if (video.error) throw new Error('The player reported an error');
      if (!chunk && Date.now() - Math.max(lastProgress, lastActivity) > STALL_MS)
        throw Object.assign(new Error('The video stopped playing'), { code: 'stalled' });
    }
    if (cancelled) {
      send({ t: 'error', message: 'cancelled' });
      return failure ?? { ok: false, code: 'cancelled', message: 'Capture cancelled' };
    }
    phase = 'end';
    send({ t: 'cend', chunks: sent });
    await expect('done');
    return { ok: true, chunks: sent, bytes };
  } catch (e) {
    if (!cancelled) console.warn('[vdown] capture failed during', phase, e instanceof Error ? e.stack : e);
    const code = (e as { code?: CaptureResult extends { code: infer C } ? C : never }).code;
    try {
      send({ t: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'failed' });
    } catch {
      // gone
    }
    return (
      failure ?? {
        ok: false,
        code: code ?? 'failed',
        message: `${phase}: ${e instanceof Error ? e.message : 'failed'}`,
      }
    );
  } finally {
    cleanup();
  }
}
