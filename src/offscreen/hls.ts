import { parseHls } from '@/lib/hls/parser';
import { fetchText } from '@/lib/netprobe';
import { SpeedMeter } from '@/lib/queue';
import type { HlsKey, HlsMediaPlaylist, HlsSegment } from '@/types/hls';
import type { JobProgress } from '@/types/download';
import { CancelledError, PipelineError } from './errors';
import { createStageFile, freeBytes } from './opfs';

export interface StageOptions {
  jobId: string;
  playlistUrl: string;
  /** File name in staging; may depend on whether the segments are fMP4. */
  fileName: string | ((fragmented: boolean) => string);
  concurrency: number;
  signal: AbortSignal;
  /** Abort when staged bytes exceed this (used when FFmpeg must later hold the result in memory). */
  maxBytes?: number;
  onProgress: (p: JobProgress) => void;
}

export interface StagedMedia {
  file: File;
  bytes: number;
  fragmented: boolean;
  durationSec: number;
}

const RETRIES = 3;

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new CancelledError())), { once: true });
  });

/**
 * fetch() that classifies failures. A rejected fetch to another origin means CORS refusal or a network error;
 * the browser does not distinguish them, so the message says both and the UI explains how to grant access.
 */
async function request(url: string, signal: AbortSignal, range?: { offset: number; length: number }): Promise<Response> {
  const headers: Record<string, string> = {};
  if (range) headers['Range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  let lastErr: PipelineError = new PipelineError('network', 'Request failed');
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    check(signal);
    let res: Response | undefined;
    try {
      res = await fetch(url, { credentials: 'include', cache: 'no-store', headers, signal });
    } catch {
      if (signal.aborted) throw new CancelledError();
      lastErr = new PipelineError('cors', 'The request was blocked: the site refused cross-origin access or the network failed');
    }
    if (res) {
      if (res.ok || res.status === 206) return res;
      lastErr = new PipelineError('http-error', `HTTP ${res.status}`);
      // Client errors (403, 404 ...) will not fix themselves; server errors and throttling might.
      if (res.status < 500 && res.status !== 429) throw lastErr;
    }
    if (attempt < RETRIES) await sleep(500 * 2 ** attempt, signal);
  }
  throw lastErr;
}

async function getBytes(url: string, signal: AbortSignal, range?: { offset: number; length: number }): Promise<Uint8Array> {
  const res = await request(url, signal, range);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadMediaPlaylist(url: string, signal: AbortSignal): Promise<HlsMediaPlaylist> {
  check(signal);
  const res = await fetchText(url, fetch, 'include');
  if (!res.ok) {
    throw new PipelineError(res.kind === 'http' ? 'http-error' : 'cors', res.kind === 'http' ? `HTTP ${res.status ?? 0}` : 'The playlist request was blocked');
  }
  const parsed = parseHls(res.text ?? '', res.finalUrl || url);
  if (!parsed.ok) throw new PipelineError('invalid', `Playlist error: ${parsed.error.code}`);
  if (parsed.playlist.kind !== 'hls-media') throw new PipelineError('invalid', 'Expected a media playlist');
  const p = parsed.playlist;
  if (p.hasDrm) throw new PipelineError('protected', 'This stream uses DRM or SAMPLE-AES encryption, which is not supported');
  if (!p.endList) throw new PipelineError('invalid', 'Live streams cannot be downloaded');
  return p;
}

function ivFor(key: HlsKey, sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, sequence >>> 0);
  }
  return iv;
}

/** Download a media playlist's segments (decrypting AES-128) in order into a file on disk. */
export async function stageHlsPlaylist(opts: StageOptions): Promise<StagedMedia> {
  const { signal } = opts;
  const playlist = await loadMediaPlaylist(opts.playlistUrl, signal);
  const segs = playlist.segments;

  const free = await freeBytes();
  if (free !== undefined && free < 64 * 1024 * 1024) {
    throw new PipelineError('out-of-memory', 'Not enough free browser storage to stage this download');
  }

  const keys = new Map<string, Promise<CryptoKey>>();
  const keyFor = (k: HlsKey): Promise<CryptoKey> => {
    const uri = k.uri;
    if (!uri) throw new PipelineError('decrypt', 'Encrypted stream without a key URI');
    let p = keys.get(uri);
    if (!p) {
      p = (async () => {
        const raw = await getBytes(uri, signal);
        if (raw.byteLength !== 16) throw new PipelineError('decrypt', 'The decryption key has an unexpected size');
        return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['decrypt']);
      })();
      keys.set(uri, p);
    }
    return p;
  };

  const out = await createStageFile(opts.jobId, typeof opts.fileName === 'function' ? opts.fileName(playlist.fragmented) : opts.fileName);
  const meter = new SpeedMeter();
  const started = Date.now();
  let downloadedBytes = 0;
  let writeIdx = 0;
  let nextIdx = 0;
  const window = Math.max(2, opts.concurrency * 3);
  const done = new Map<number, Uint8Array>();
  const waiters: Array<() => void> = [];
  let lastMapKey = '';
  let writing: Promise<void> = Promise.resolve();

  const report = () => {
    const now = Date.now();
    meter.update(writeIdx, now);
    const p: JobProgress = {
      fraction: writeIdx / segs.length,
      unitsDone: writeIdx,
      unitsTotal: segs.length,
      bytesDone: out.bytes,
    };
    const elapsed = (now - started) / 1000;
    if (writeIdx >= 3 && elapsed > 2) p.etaSeconds = ((segs.length - writeIdx) * elapsed) / writeIdx;
    p.bytesPerSecond = elapsed > 1.5 ? downloadedBytes / elapsed : undefined;
    if (p.bytesPerSecond === undefined) delete p.bytesPerSecond;
    opts.onProgress(p);
  };

  const fetchSegment = async (seg: HlsSegment): Promise<Uint8Array> => {
    let data = await getBytes(seg.uri, signal, seg.byteRange);
    downloadedBytes += data.byteLength;
    const key = seg.key;
    if (key && key.method === 'AES-128') {
      try {
        const ck = await keyFor(key);
        const clear = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(key, seg.sequence) as Uint8Array<ArrayBuffer> }, ck, data as Uint8Array<ArrayBuffer>);
        data = new Uint8Array(clear);
      } catch (e) {
        if (e instanceof PipelineError || e instanceof CancelledError) throw e;
        throw new PipelineError('decrypt', 'Failed to decrypt a segment (wrong key or corrupted data)');
      }
    }
    return data;
  };

  const flush = (): Promise<void> => {
    writing = writing.then(async () => {
      for (;;) {
        const data = done.get(writeIdx);
        if (!data) break;
        done.delete(writeIdx);
        const seg = segs[writeIdx] as HlsSegment;
        if (seg.map) {
          const mapKey = `${seg.map.uri}|${seg.map.byteRange?.offset ?? ''}`;
          if (mapKey !== lastMapKey) {
            await out.write(await getBytes(seg.map.uri, signal, seg.map.byteRange));
            lastMapKey = mapKey;
          }
        }
        await out.write(data);
        writeIdx++;
        if (opts.maxBytes !== undefined && out.bytes > opts.maxBytes) {
          throw new PipelineError('too-large', 'The download exceeds the configured memory limit');
        }
        for (const w of waiters.splice(0)) w();
      }
      report();
    });
    return writing;
  };

  const worker = async () => {
    for (;;) {
      check(signal);
      const i = nextIdx;
      if (i >= segs.length) return;
      if (i >= writeIdx + window) {
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      nextIdx++;
      done.set(i, await fetchSegment(segs[i] as HlsSegment));
      await flush();
    }
  };

  try {
    const n = Math.max(1, Math.min(opts.concurrency, segs.length));
    await Promise.all(Array.from({ length: n }, worker));
    await flush();
    const file = await out.finish();
    return { file, bytes: out.bytes, fragmented: playlist.fragmented, durationSec: playlist.totalDuration };
  } catch (e) {
    await out.abort();
    throw e;
  } finally {
    // Wake anything still parked so a failed job does not leave dangling promises.
    for (const w of waiters.splice(0)) w();
  }
}

/** Stream one direct file into staging with byte-accurate progress. */
export async function stageDirectFile(opts: Omit<StageOptions, 'playlistUrl' | 'concurrency' | 'fileName'> & { url: string; fileName: string }): Promise<{ file: File; bytes: number }> {
  const { signal } = opts;
  const res = await request(opts.url, signal);
  const total = Number(res.headers.get('content-length')) || undefined;
  if (opts.maxBytes !== undefined && total !== undefined && total > opts.maxBytes) {
    throw new PipelineError('too-large', 'The file exceeds the configured memory limit');
  }
  const out = await createStageFile(opts.jobId, opts.fileName);
  const meter = new SpeedMeter();
  try {
    const reader = res.body?.getReader();
    if (!reader) throw new PipelineError('network', 'The response has no body');
    for (;;) {
      check(signal);
      const { done, value } = await reader.read();
      if (done) break;
      await out.write(value);
      if (opts.maxBytes !== undefined && out.bytes > opts.maxBytes) {
        throw new PipelineError('too-large', 'The file exceeds the configured memory limit');
      }
      meter.update(out.bytes, Date.now());
      const p: JobProgress = { bytesDone: out.bytes };
      if (total !== undefined) {
        p.bytesTotal = total;
        p.fraction = Math.min(1, out.bytes / total);
      }
      const speed = meter.bytesPerSecond;
      if (speed !== undefined) p.bytesPerSecond = speed;
      const eta = meter.etaSeconds(total === undefined ? undefined : total - out.bytes);
      if (eta !== undefined) p.etaSeconds = eta;
      opts.onProgress(p);
    }
    const file = await out.finish();
    return { file, bytes: out.bytes };
  } catch (e) {
    await out.abort();
    throw e;
  }
}
