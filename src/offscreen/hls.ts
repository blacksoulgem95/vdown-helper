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
  credentialedOrigins?: string[];
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
/**
 * Cookies are only sent to origins the user granted access to (DownloadRequest.credentialedOrigins). Everything
 * else is fetched without credentials, which is also what wildcard-CORS CDNs require.
 */
type Creds = (url: string) => RequestCredentials;
export function credentialsFor(origins: string[] | undefined): Creds {
  const granted = new Set(origins ?? []);
  return (url) => {
    try {
      return granted.has(new URL(url).origin) ? 'include' : 'omit';
    } catch {
      return 'omit';
    }
  };
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new CancelledError())), { once: true });
  });

/** Hard limits against hostile or broken servers (a playlist is attacker-controlled data). */
const MAX_RESOURCE_BYTES = 256 * 1024 * 1024; // one segment, key or init section
const MAX_SEGMENTS = 20_000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024; // everything staged for one playlist
const HEADERS_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 30_000;

/** An AbortSignal that follows `parent` and can also be aborted on its own (for timeouts). */
function childSignal(parent: AbortSignal): { signal: AbortSignal; abort: () => void } {
  const c = new AbortController();
  if (parent.aborted) c.abort();
  else parent.addEventListener('abort', () => c.abort(), { once: true });
  return { signal: c.signal, abort: () => c.abort() };
}

/**
 * fetch() that classifies failures. A rejected fetch to another origin means CORS refusal or a network error;
 * the browser does not distinguish them, so the message says both and the UI explains how to grant access.
 * The returned response must be consumed with readCapped(), which enforces the size and stall limits.
 */
async function request(
  url: string,
  signal: AbortSignal,
  creds: Creds,
  range?: { offset: number; length: number },
): Promise<{ res: Response; abort: () => void; signal: AbortSignal }> {
  const headers: Record<string, string> = {};
  if (range) headers['Range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  let lastErr: PipelineError = new PipelineError('network', 'Request failed');
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    check(signal);
    const child = childSignal(signal);
    const timer = setTimeout(child.abort, HEADERS_TIMEOUT_MS);
    let res: Response | undefined;
    try {
      res = await fetch(url, { cache: 'no-store', headers, signal: child.signal, credentials: creds(url) });
    } catch {
      if (signal.aborted) throw new CancelledError();
      lastErr = new PipelineError(
        'cors',
        'The request was blocked: the site refused cross-origin access, did not answer in time, or the network failed',
      );
    } finally {
      clearTimeout(timer);
    }
    if (res) {
      if (res.ok || res.status === 206) return { res, abort: child.abort, signal: child.signal };
      void res.body?.cancel().catch(() => undefined);
      lastErr = new PipelineError('http-error', `HTTP ${res.status}`);
      // Client errors (403, 404 ...) will not fix themselves; server errors and throttling might.
      if (res.status < 500 && res.status !== 429) throw lastErr;
    }
    if (attempt < RETRIES) await sleep(500 * 2 ** attempt, signal);
  }
  throw lastErr;
}

/** Read a body with a byte cap and a stall (idle) timeout. */
async function readCapped(
  res: Response,
  abort: () => void,
  signal: AbortSignal,
  maxBytes: number,
  onChunk?: (chunk: Uint8Array) => Promise<void> | void,
  /** Stop reading successfully once this many bytes arrived (the rest is not wanted, and is not an error). */
  stopAt?: number,
): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (!reader) throw new PipelineError('network', 'The response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const stalled = new Promise<never>((_, reject) => {
        idle = setTimeout(() => {
          timedOut = true;
          abort();
          reject(new PipelineError('network', 'The server stopped sending data'));
        }, IDLE_TIMEOUT_MS);
      });
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await Promise.race([reader.read(), stalled]);
      } catch (e) {
        // `signal` follows the user's cancel button; our own timeout also aborts the request, so tell them apart.
        if (!timedOut && signal.aborted) throw new CancelledError();
        throw e instanceof PipelineError ? e : new PipelineError('network', 'The download was interrupted');
      } finally {
        clearTimeout(idle);
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (stopAt !== undefined && total >= stopAt) {
        chunks.push(step.value);
        abort();
        break;
      }
      if (total > maxBytes) {
        abort();
        throw new PipelineError('too-large', 'A file on the server is larger than the allowed size');
      }
      if (onChunk) await onChunk(step.value);
      else chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (onChunk) return undefined;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function getBytes(
  url: string,
  signal: AbortSignal,
  creds: Creds,
  range?: { offset: number; length: number },
  maxBytes = MAX_RESOURCE_BYTES,
): Promise<Uint8Array> {
  const { res, abort, signal: s } = await request(url, signal, creds, range);
  // A server that ignores Range answers 200 with the whole resource: keep only the requested slice.
  const ignoredRange = range !== undefined && res.status === 200;
  const stopAt = ignoredRange ? range.offset + range.length : undefined;
  if (stopAt !== undefined && stopAt > maxBytes) {
    abort();
    throw new PipelineError('too-large', 'A file on the server is larger than the allowed size');
  }
  const body = (await readCapped(res, abort, s, maxBytes, undefined, stopAt)) as Uint8Array;
  if (!ignoredRange) {
    if (range && body.byteLength !== range.length) {
      throw new PipelineError('invalid', 'The server returned a different byte range than requested');
    }
    return body;
  }
  if (body.byteLength < range.offset + range.length) {
    throw new PipelineError('invalid', 'The server ignored the byte range and the data is too short');
  }
  return body.slice(range.offset, range.offset + range.length);
}

export async function loadMediaPlaylist(
  url: string,
  signal: AbortSignal,
  creds: Creds,
): Promise<HlsMediaPlaylist> {
  check(signal);
  const res = await fetchText(url, fetch, creds(url));
  if (!res.ok) {
    throw new PipelineError(
      res.kind === 'http' ? 'http-error' : 'cors',
      res.kind === 'http' ? `HTTP ${res.status ?? 0}` : 'The playlist request was blocked',
    );
  }
  const parsed = parseHls(res.text ?? '', res.finalUrl || url);
  if (!parsed.ok) throw new PipelineError('invalid', `Playlist error: ${parsed.error.code}`);
  if (parsed.playlist.kind !== 'hls-media') throw new PipelineError('invalid', 'Expected a media playlist');
  const p = parsed.playlist;
  if (p.hasDrm)
    throw new PipelineError(
      'protected',
      'This stream uses DRM or SAMPLE-AES encryption, which is not supported',
    );
  if (!p.endList) throw new PipelineError('invalid', 'Live streams cannot be downloaded');
  if (p.segments.length > MAX_SEGMENTS)
    throw new PipelineError('invalid', 'The playlist has too many segments');
  return p;
}

/** Fetch a manifest (text) with the same limits, credential rules and error classification as segments. */
export async function fetchManifestText(
  url: string,
  signal: AbortSignal,
  creds: Creds,
): Promise<{ text: string; url: string }> {
  check(signal);
  const res = await fetchText(url, fetch, creds(url));
  if (!res.ok) {
    throw new PipelineError(
      res.kind === 'http' ? 'http-error' : 'cors',
      res.kind === 'http' ? `HTTP ${res.status ?? 0}` : 'The manifest request was blocked',
    );
  }
  return { text: res.text ?? '', url: res.finalUrl || url };
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
  const playlist = await loadMediaPlaylist(
    opts.playlistUrl,
    opts.signal,
    credentialsFor(opts.credentialedOrigins),
  );
  return stageSegmentList({
    ...opts,
    segs: playlist.segments,
    fragmented: playlist.fragmented,
    durationSec: playlist.totalDuration,
  });
}

export type SegmentListOptions = Omit<StageOptions, 'playlistUrl'> & {
  segs: HlsSegment[];
  fragmented: boolean;
  durationSec: number;
};

/**
 * The shared segment engine (HLS, DASH, live recording): fetch segments in parallel but write them to disk in order,
 * decrypting AES-128 where a key applies, writing each init section once, with caps, retries and cancellation.
 */
export async function stageSegmentList(opts: SegmentListOptions): Promise<StagedMedia> {
  const { signal, segs } = opts;
  const creds = credentialsFor(opts.credentialedOrigins);
  if (segs.length > MAX_SEGMENTS) throw new PipelineError('invalid', 'The stream has too many segments');

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
        const raw = await getBytes(uri, signal, creds, undefined, 1024);
        if (raw.byteLength !== 16)
          throw new PipelineError('decrypt', 'The decryption key has an unexpected size');
        return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['decrypt']);
      })();
      keys.set(uri, p);
    }
    return p;
  };

  const out = await createStageFile(
    opts.jobId,
    typeof opts.fileName === 'function' ? opts.fileName(opts.fragmented) : opts.fileName,
  );
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

  const decryptBytes = async (key: HlsKey, data: Uint8Array, sequence: number): Promise<Uint8Array> => {
    try {
      const ck = await keyFor(key);
      const clear = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: ivFor(key, sequence) as Uint8Array<ArrayBuffer> },
        ck,
        data as Uint8Array<ArrayBuffer>,
      );
      return new Uint8Array(clear);
    } catch (e) {
      if (e instanceof PipelineError || e instanceof CancelledError) throw e;
      throw new PipelineError('decrypt', 'Failed to decrypt data (wrong key or corrupted data)');
    }
  };

  const fetchSegment = async (seg: HlsSegment): Promise<Uint8Array> => {
    let data = await getBytes(seg.uri, signal, creds, seg.byteRange);
    downloadedBytes += data.byteLength;
    const key = seg.key;
    if (key && key.method === 'AES-128') data = await decryptBytes(key, data, seg.sequence);
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
            let init = await getBytes(seg.map.uri, signal, creds, seg.map.byteRange);
            // RFC 8216 4.3.2.5: a key in effect at the EXT-X-MAP also encrypts the initialisation section.
            if (seg.map.key && seg.map.key.method === 'AES-128')
              init = await decryptBytes(seg.map.key, init, seg.sequence);
            await out.write(init);
            lastMapKey = mapKey;
          }
        }
        await out.write(data);
        writeIdx++;
        if (out.bytes > (opts.maxBytes ?? MAX_TOTAL_BYTES)) {
          throw new PipelineError('too-large', 'The download exceeds the configured size limit');
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
    return { file, bytes: out.bytes, fragmented: opts.fragmented, durationSec: opts.durationSec };
  } catch (e) {
    await out.abort();
    throw e;
  } finally {
    // Wake anything still parked so a failed job does not leave dangling promises.
    for (const w of waiters.splice(0)) w();
  }
}

/** Stream one direct file into staging with byte-accurate progress. */
export async function stageDirectFile(
  opts: Omit<StageOptions, 'playlistUrl' | 'concurrency' | 'fileName'> & { url: string; fileName: string },
): Promise<{ file: File; bytes: number }> {
  const { signal } = opts;
  const { res, abort, signal: s } = await request(opts.url, signal, credentialsFor(opts.credentialedOrigins));
  const total = Number(res.headers.get('content-length')) || undefined;
  const cap = opts.maxBytes ?? MAX_TOTAL_BYTES;
  if (total !== undefined && total > cap) {
    abort();
    throw new PipelineError('too-large', 'The file exceeds the configured size limit');
  }
  const out = await createStageFile(opts.jobId, opts.fileName);
  const meter = new SpeedMeter();
  try {
    await readCapped(res, abort, s, cap, async (value) => {
      check(signal);
      await out.write(value);
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
    });
    const file = await out.finish();
    return { file, bytes: out.bytes };
  } catch (e) {
    await out.abort();
    throw e;
  }
}
