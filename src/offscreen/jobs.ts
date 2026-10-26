import { buildFfmpegArgs, MIME_BY_EXTENSION } from '@/lib/ffmpegArgs';
import { log } from '@/lib/security';
import { heldLimit } from '@/types/ingest';
import type { DownloadRequest, JobProgress, JobStage } from '@/types/download';
import type { OffscreenEvent, OffscreenPlan } from '@/types/messages';
import { CancelledError, PipelineError, asPipelineError } from './errors';
import { runFfmpeg } from './ffmpeg';
import { stageDashRepresentation } from './dash';
import { expectCapture, expectIngest } from './ingest';
import { stageDirectFile, stageHlsPlaylist, type StageOptions } from './hls';
import { removeJobDir } from './opfs';
import { storageReady } from './startup';
import { buildSubtitle } from './subtitle';
import { buildZip } from './zip';
import { assembleCapture } from './capture';

interface Running {
  abort: AbortController;
  blobUrl?: string;
}
const running = new Map<string, Running>();
const MB = 1024 * 1024;

function emit(ev: OffscreenEvent): void {
  chrome.runtime.sendMessage(ev).catch(() => undefined);
}

function makeProgressSender(jobId: string) {
  let last = 0;
  return (progress: JobProgress, force = false) => {
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    emit({ channel: 'vdown-offscreen-event', type: 'progress', jobId, progress });
  };
}

const stage = (jobId: string, s: JobStage) =>
  emit({ channel: 'vdown-offscreen-event', type: 'stage', jobId, stage: s });

export function startJob(jobId: string, request: DownloadRequest, plan: OffscreenPlan): void {
  if (running.has(jobId)) return;
  const entry: Running = { abort: new AbortController() };
  running.set(jobId, entry);
  void execute(jobId, request, plan, entry).catch((e: unknown) => {
    const err = asPipelineError(e);
    if (err instanceof CancelledError) {
      emit({ channel: 'vdown-offscreen-event', type: 'cancelled', jobId });
    } else {
      log.warn('pipeline failed:', err.code, err.message);
      emit({ channel: 'vdown-offscreen-event', type: 'failed', jobId, code: err.code, message: err.message });
    }
    void releaseJob(jobId);
  });
}

export function cancelJob(jobId: string): void {
  running.get(jobId)?.abort.abort();
}

/** Free staged files and the blob URL once Chrome has finished (or abandoned) saving. */
export async function releaseJob(jobId: string): Promise<void> {
  const r = running.get(jobId);
  if (r?.blobUrl) URL.revokeObjectURL(r.blobUrl);
  running.delete(jobId);
  await removeJobDir(jobId);
}

function ext(fragmented: boolean): string {
  return fragmented ? 'mp4' : 'ts';
}

/** Stage one stream: an HLS media playlist, or one representation of a DASH manifest. */
function stageStream(url: string, opts: Omit<StageOptions, 'playlistUrl'>, dash: boolean) {
  return dash
    ? stageDashRepresentation({ ...opts, ref: url })
    : stageHlsPlaylist({ ...opts, playlistUrl: url });
}

async function execute(
  jobId: string,
  req: DownloadRequest,
  plan: OffscreenPlan,
  entry: Running,
): Promise<void> {
  const { signal } = entry.abort;
  const send = makeProgressSender(jobId);
  const maxBytes = plan.requiresFfmpeg ? plan.maxMemoryMb * MB : undefined;
  const credentialedOrigins = req.credentialedOrigins ?? [];
  stage(jobId, 'downloading');

  // A capture registers like the held bytes below: the page connects the moment the background starts it.
  const captured =
    plan.pipeline === 'capture' && req.held
      ? expectCapture({
          jobId,
          tabId: req.tabId,
          frameId: req.held.frameId ?? 0,
          maxBytes: plan.maxMemoryMb * MB,
          signal,
          onProgress: (bytes, frac) =>
            send({ bytesDone: bytes, ...(frac !== undefined ? { fraction: frac * 0.8 } : {}) }),
        })
      : undefined;
  captured?.catch(() => undefined);

  // The page may connect with its bytes at any moment, so the expectation is registered before anything is awaited.
  const heldBytes =
    req.held && !req.capture
      ? expectIngest({
          jobId,
          tabId: req.tabId,
          frameId: req.held.frameId ?? 0,
          fileName: `source.${req.sourceFormat === 'unknown' ? 'bin' : req.sourceFormat}`,
          maxBytes:
            maxBytes === undefined ? heldLimit(req.held.kind) : Math.min(maxBytes, heldLimit(req.held.kind)),
          signal,
          onProgress: (bytes, total) =>
            send({ bytesDone: bytes, bytesTotal: total, fraction: total ? bytes / total : 1 }),
        })
      : undefined;
  heldBytes?.catch(() => undefined); // reported where it is awaited
  await storageReady;

  // Capture of a MediaSource player: what the page recorded is assembled into one file per quality it played.
  if (captured) {
    const ingest = await captured;
    stage(jobId, 'merging');
    const parts = await assembleCapture({
      jobId,
      ingest,
      signal,
      maxBytes: plan.maxMemoryMb * MB,
      onProgress: (p) =>
        send({ ...p, ...(p.fraction !== undefined ? { fraction: 0.8 + p.fraction * 0.2 } : {}) }),
    });
    if (signal.aborted) throw new CancelledError();
    const urls = parts.map((p) =>
      URL.createObjectURL(
        new Blob([p.data as Uint8Array<ArrayBuffer>], {
          type: MIME_BY_EXTENSION[p.extension] ?? 'application/octet-stream',
        }),
      ),
    );
    entry.blobUrl = urls[0];
    // further parts are jobs of their own: they need an entry so their blob URL is revoked when they are released
    const extraParts = parts.slice(1).map((p, i) => {
      const id = crypto.randomUUID();
      running.set(id, { abort: new AbortController(), blobUrl: urls[i + 1] as string });
      return { jobId: id, blobUrl: urls[i + 1] as string, bytes: p.data.byteLength, extension: p.extension };
    });
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: urls[0] as string,
      bytes: parts[0]?.data.byteLength ?? 0,
      extension: parts[0]?.extension ?? 'mp4',
      ...(extraParts.length > 0 ? { extraParts } : {}),
    });
    return;
  }

  // ZIP of plain files: fetched one by one, written straight to disk.
  if (plan.pipeline === 'zip') {
    const zipped = await buildZip(jobId, req, plan.maxMemoryMb, signal, send);
    if (signal.aborted) throw new CancelledError();
    entry.blobUrl = URL.createObjectURL(zipped.file);
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: entry.blobUrl,
      bytes: zipped.bytes,
      skipped: zipped.failed + (req.zip?.left ?? 0),
    });
    return;
  }

  // Subtitles: small text, joined and converted in memory. No staging, no FFmpeg.
  if (plan.pipeline === 'subtitle') {
    const result = await buildSubtitle(req, signal, send);
    if (signal.aborted) throw new CancelledError();
    entry.blobUrl = URL.createObjectURL(result.blob);
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: entry.blobUrl,
      bytes: result.blob.size,
    });
    return;
  }

  // 1. Stage the source(s) on disk.
  let videoFile: File;
  let audioFile: File | undefined;
  let durationSec = req.durationSec;
  const hasAudioInput = req.audioUrl !== undefined;

  if (req.isHls || req.isDash) {
    const weight = hasAudioInput ? 0.5 : 1;
    const video = await stageStream(
      req.sourceUrl,
      {
        jobId,
        fileName: (frag) => `video.${ext(frag)}`,
        concurrency: plan.segmentConcurrency,
        credentialedOrigins,
        signal,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        onProgress: (p) =>
          send({ ...p, ...(p.fraction !== undefined ? { fraction: p.fraction * weight } : {}) }),
      },
      req.isDash === true,
    );
    videoFile = video.file;
    durationSec = durationSec ?? video.durationSec;
    if (hasAudioInput && req.audioUrl) {
      const audio = await stageStream(
        req.audioUrl,
        {
          jobId,
          fileName: (frag) => `audio.${frag ? 'mp4' : 'ts'}`,
          concurrency: plan.segmentConcurrency,
          credentialedOrigins,
          signal,
          ...(maxBytes !== undefined ? { maxBytes: Math.max(0, maxBytes - video.bytes) } : {}),
          onProgress: (p) =>
            send({ ...p, ...(p.fraction !== undefined ? { fraction: 0.5 + p.fraction * 0.5 } : {}) }),
        },
        req.isDash === true,
      );
      audioFile = audio.file;
    }
  } else if (req.held) {
    // Bytes only the page has (a data: URL): the page sends them to us; we never fetch the URL.
    const ingested = await (heldBytes as NonNullable<typeof heldBytes>);
    videoFile = ingested.file;
  } else {
    const staged = await stageDirectFile({
      jobId,
      url: req.sourceUrl,
      fileName: `source.${req.sourceFormat === 'unknown' ? 'bin' : req.sourceFormat}`,
      credentialedOrigins,
      signal,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      onProgress: send,
    });
    videoFile = staged.file;
  }
  send({ fraction: 1 }, true);

  // 2. Concatenation needs no processing: hand the disk-backed file straight to Chrome.
  if (!plan.requiresFfmpeg) {
    entry.blobUrl = URL.createObjectURL(videoFile);
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: entry.blobUrl,
      bytes: videoFile.size,
    });
    return;
  }

  // 3. FFmpeg: copy/merge ("merging") or audio re-encode ("encoding").
  const reencodes = plan.audio === 'transcode' || plan.video === 'transcode';
  stage(jobId, reencodes ? 'encoding' : 'merging');
  const output = `out.${plan.extension}`;
  const inputs = audioFile ? [videoFile, audioFile] : [videoFile];
  const data = await runFfmpeg({
    inputs,
    output,
    signal,
    ...(durationSec !== undefined ? { durationSec } : {}),
    onProgress: (fraction) => send(fraction === undefined ? {} : { fraction }),
    args: (paths) =>
      buildFfmpegArgs({
        mode: req.mode,
        extension: plan.extension,
        video: plan.video,
        audio: plan.audio,
        videoPath: paths[0] as string,
        ...(paths[1] ? { audioPath: paths[1] } : {}),
        audioFormat: req.audioFormat,
        audioBitrate: req.audioBitrate,
        output,
      }),
  });
  if (signal.aborted) throw new CancelledError();
  if (data.byteLength === 0) throw new PipelineError('ffmpeg', 'FFmpeg produced an empty file');
  // The staged inputs are no longer needed; the result lives in memory until Chrome has saved it.
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
    type: MIME_BY_EXTENSION[plan.extension] ?? 'application/octet-stream',
  });
  entry.blobUrl = URL.createObjectURL(blob);
  emit({ channel: 'vdown-offscreen-event', type: 'ready', jobId, blobUrl: entry.blobUrl, bytes: blob.size });
}
