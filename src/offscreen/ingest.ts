import { ChunkClassifier, type ChunkMeta } from '@/lib/mseParts';
import { log } from '@/lib/security';
import {
  HELD_BLOB_LIMIT,
  INGEST_PORT_PREFIX,
  MAX_CAPTURE_CHUNKS,
  MAX_CAPTURE_TRACKS,
  type IngestDown,
  type IngestUp,
} from '@/types/ingest';
import { CancelledError, PipelineError } from './errors';
import { createStageFile } from './opfs';
import { storageReady } from './startup';

/** What a capture delivers: every appended chunk of every SourceBuffer, staged on disk, with what is known about each. */
export interface CaptureIngest {
  files: Map<string, File>;
  metas: ChunkMeta[];
  bytes: number;
}

interface Pending {
  mode: 'file' | 'capture';
  tabId: number;
  frameId: number;
  fileName: string;
  jobId: string;
  maxBytes: number;
  signal: AbortSignal;
  onProgress: (bytes: number, total: number) => void;
  resolve: (r: never) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
}

const pending = new Map<string, Pending>();
const WAIT_FOR_PAGE_MS = 20_000;

/**
 * Register that a job is about to receive page-held bytes. Must be called before the background tells the page to
 * send them. Only the content script of the expected tab and frame is accepted, once, and only up to `maxBytes`.
 */
export function expectIngest(opts: {
  jobId: string;
  tabId: number;
  frameId: number;
  fileName: string;
  maxBytes?: number;
  signal: AbortSignal;
  onProgress: (bytes: number, total: number) => void;
}): Promise<{ file: File; bytes: number; mime: string }> {
  return new Promise((resolve, reject) => {
    const entry: Pending = {
      mode: 'file',
      tabId: opts.tabId,
      frameId: opts.frameId,
      fileName: opts.fileName,
      jobId: opts.jobId,
      maxBytes: Math.min(opts.maxBytes ?? HELD_BLOB_LIMIT, HELD_BLOB_LIMIT),
      signal: opts.signal,
      onProgress: opts.onProgress,
      resolve,
      reject,
      claimed: false,
      timer: setTimeout(() => {
        if (pending.delete(opts.jobId))
          reject(new PipelineError('network', 'The page did not provide the data'));
      }, WAIT_FOR_PAGE_MS),
    };
    pending.set(opts.jobId, entry);
    opts.signal.addEventListener(
      'abort',
      () => {
        if (pending.delete(opts.jobId)) {
          clearTimeout(entry.timer);
          reject(new CancelledError());
        }
      },
      { once: true },
    );
  });
}

/** Register a capture (MSE recording) that is about to arrive: same rules as expectIngest, but with no announced size. */
export function expectCapture(opts: {
  jobId: string;
  tabId: number;
  frameId: number;
  maxBytes: number;
  signal: AbortSignal;
  onProgress: (bytes: number, fraction: number | undefined) => void;
}): Promise<CaptureIngest> {
  return new Promise((resolve, reject) => {
    const entry: Pending = {
      mode: 'capture',
      tabId: opts.tabId,
      frameId: opts.frameId,
      fileName: '',
      jobId: opts.jobId,
      maxBytes: opts.maxBytes,
      signal: opts.signal,
      onProgress: (bytes, total) => opts.onProgress(bytes, total > 0 ? total : undefined),
      resolve,
      reject,
      claimed: false,
      timer: setTimeout(() => {
        if (pending.delete(opts.jobId))
          reject(new PipelineError('network', 'The page did not start the capture'));
      }, WAIT_FOR_PAGE_MS),
    };
    pending.set(opts.jobId, entry);
    opts.signal.addEventListener(
      'abort',
      () => {
        if (pending.delete(opts.jobId)) {
          clearTimeout(entry.timer);
          reject(new CancelledError());
        }
      },
      { once: true },
    );
  });
}

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Port handler: wire this to chrome.runtime.onConnect in the offscreen document. */
export function handleIngestPort(port: chrome.runtime.Port): void {
  if (!port.name.startsWith(INGEST_PORT_PREFIX)) return;
  const jobId = port.name.slice(INGEST_PORT_PREFIX.length);
  const entry = pending.get(jobId);
  const s = port.sender;
  const reply = (m: IngestDown) => {
    try {
      port.postMessage(m);
    } catch {
      // the page went away
    }
  };
  // Own content scripts only, from the tab and frame this job belongs to, once.
  if (
    !entry ||
    entry.claimed ||
    s?.id !== chrome.runtime.id ||
    s.tab?.id !== entry.tabId ||
    (s.frameId ?? 0) !== entry.frameId
  ) {
    reply({ t: 'abort', message: 'Not expected' });
    port.disconnect();
    return;
  }
  entry.claimed = true;
  clearTimeout(entry.timer);

  let total = -1;
  let seq = 0;
  let received = 0;
  let finished = false;
  let writer: Awaited<ReturnType<typeof createStageFile>> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let mime = 'application/octet-stream';
  // capture mode
  const classifier = new ChunkClassifier();
  const writers = new Map<string, Awaited<ReturnType<typeof createStageFile>>>();
  const offsets = new Map<string, number>();
  const metas: ChunkMeta[] = [];
  let captureStarted = false;
  let captureSeq = 0;
  let captureBytes = 0;

  const fail = async (e: unknown, message: string) => {
    if (finished) return;
    finished = true;
    log.warn('transfer from the page failed:', message, e instanceof Error ? e.message : '');
    pending.delete(jobId);
    reply({ t: 'abort', message });
    await writer?.abort();
    await Promise.all([...writers.values()].map((w) => w.abort()));
    port.disconnect();
    entry.reject(e);
  };
  entry.signal.addEventListener('abort', () => void fail(new CancelledError(), 'Cancelled'), { once: true });

  port.onDisconnect.addListener(() => {
    if (!finished) void fail(new PipelineError('network', 'The page closed the connection'), 'Closed');
  });

  port.onMessage.addListener((m: IngestUp) => {
    queue = queue
      .then(async () => {
        if (finished) return;
        switch (m.t) {
          case 'begin': {
            if (entry.mode !== 'file')
              return void (await fail(new PipelineError('invalid', 'Unexpected transfer'), 'Unexpected'));
            if (total !== -1 || !Number.isSafeInteger(m.total) || m.total < 0)
              return void (await fail(new PipelineError('invalid', 'Bad start of transfer'), 'Bad start'));
            if (m.total > entry.maxBytes)
              return void (await fail(
                new PipelineError('too-large', 'The embedded data is larger than the allowed size'),
                'Too large',
              ));
            total = m.total;
            mime = typeof m.mime === 'string' ? m.mime.slice(0, 100) : mime;
            await storageReady;
            writer = await createStageFile(entry.jobId, entry.fileName);
            return;
          }
          case 'chunk': {
            if (total < 0 || !writer || m.seq !== seq || typeof m.b64 !== 'string')
              return void (await fail(new PipelineError('invalid', 'Out-of-order data'), 'Out of order'));
            const bytes = b64ToBytes(m.b64);
            received += bytes.byteLength;
            if (received > total || received > entry.maxBytes)
              return void (await fail(
                new PipelineError('too-large', 'The page sent more data than it announced'),
                'Too much data',
              ));
            await writer.write(bytes);
            seq++;
            entry.onProgress(received, total);
            reply({ t: 'ack', seq: m.seq });
            return;
          }
          case 'end': {
            if (!writer || received !== total || m.chunks !== seq)
              return void (await fail(new PipelineError('invalid', 'Incomplete data'), 'Incomplete'));
            const file = await writer.finish();
            finished = true;
            pending.delete(jobId);
            reply({ t: 'done' });
            port.disconnect();
            entry.resolve({ file, bytes: received, mime } as never);
            return;
          }
          case 'cbegin': {
            if (entry.mode !== 'capture' || captureStarted)
              return void (await fail(
                new PipelineError('invalid', 'Unexpected capture start'),
                'Unexpected',
              ));
            captureStarted = true;
            await storageReady;
            return;
          }
          case 'cchunk': {
            if (entry.mode !== 'capture' || !captureStarted || m.seq !== captureSeq)
              return void (await fail(new PipelineError('invalid', 'Out-of-order data'), 'Out of order'));
            if (typeof m.track !== 'string' || !/^\d{1,6}$/.test(m.track) || typeof m.b64 !== 'string')
              return void (await fail(new PipelineError('invalid', 'Bad chunk'), 'Bad chunk'));
            if (!writers.has(m.track) && writers.size >= MAX_CAPTURE_TRACKS)
              return void (await fail(new PipelineError('invalid', 'Too many tracks'), 'Too many tracks'));
            if (captureSeq >= MAX_CAPTURE_CHUNKS)
              return void (await fail(
                new PipelineError('too-large', 'Too many segments'),
                'Too many segments',
              ));
            const bytes = b64ToBytes(m.b64);
            captureBytes += bytes.byteLength;
            if (captureBytes > entry.maxBytes)
              return void (await fail(
                new PipelineError('too-large', 'The capture exceeds the configured size limit'),
                'Too large',
              ));
            let w = writers.get(m.track);
            if (!w) {
              w = await createStageFile(entry.jobId, `track-${m.track}.bin`);
              writers.set(m.track, w);
              offsets.set(m.track, 0);
            }
            const at = offsets.get(m.track) ?? 0;
            await w.write(bytes);
            offsets.set(m.track, at + bytes.byteLength);
            metas.push(...classifier.classifyAll(m.track, captureSeq, bytes, at));
            captureSeq++;
            entry.onProgress(
              captureBytes,
              typeof m.frac === 'number' && m.frac >= 0 && m.frac <= 1 ? m.frac : 0,
            );
            reply({ t: 'ack', seq: m.seq });
            return;
          }
          case 'cend': {
            if (entry.mode !== 'capture' || !captureStarted || m.chunks !== captureSeq)
              return void (await fail(new PipelineError('invalid', 'Incomplete capture'), 'Incomplete'));
            const files = new Map<string, File>();
            for (const [track, w] of writers) files.set(track, await w.finish());
            finished = true;
            pending.delete(jobId);
            reply({ t: 'done' });
            port.disconnect();
            entry.resolve({ files, metas, bytes: captureBytes } as never);
            return;
          }
          case 'error':
            // A capture the user cancelled from the page's own banner is a cancellation, not a failure.
            if (entry.mode === 'capture' && m.message === 'cancelled')
              return void (await fail(new CancelledError(), 'Cancelled'));
            return void (await fail(
              new PipelineError('network', 'The page could not send the data'),
              'Page error',
            ));
        }
      })
      .catch((e: unknown) => fail(e, 'Failed'));
  });
  reply({ t: 'ready' });
}
