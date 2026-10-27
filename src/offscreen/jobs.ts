import { buildFfmpegArgs, MIME_BY_EXTENSION } from '@/lib/ffmpegArgs';
import { log } from '@/lib/security';
import { heldLimit } from '@/types/ingest';
import type { DownloadRequest, JobProgress, JobStage } from '@/types/download';
import type { OffscreenEvent, OffscreenPlan } from '@/types/messages';
import { CancelledError, PipelineError, asPipelineError } from './errors';
import { runFfmpeg } from './ffmpeg';
import { stageDashRepresentation } from './dash';
import { expectCapture, expectIngest, expectRecording } from './ingest';
import { stageDirectFile, stageHlsPlaylist, type StageOptions } from './hls';
import { removeJobDir } from './opfs';
import { storageReady } from './startup';
import { buildSubtitle } from './subtitle';
import { buildZip } from './zip';
import { assembleCapture } from './capture';
import { dashLiveSource, hlsLiveSource, liveProgress, recordLiveTrack, type LiveTrackResult } from './live';

interface Running {
  abort: AbortController;
  /** Live recordings: aborted when the user presses Stop (the recording then ends normally). */
  stop?: AbortController;
  blobUrl?: string;
}
const running = new Map<string, Running>();
const MB = 1024 * 1024;

function emit(ev: OffscreenEvent): void {
  chrome.runtime.sendMessage(ev).catch(() => undefined);
}

export function makeProgressSender(jobId: string) {
  let last = 0;
  return (progress: JobProgress, force = false) => {
    const now = Date.now();
    // The report that completes a stage is never dropped: otherwise a fast download can end showing stale counters.
    const complete =
      progress.fraction === 1 ||
      (progress.unitsTotal !== undefined && progress.unitsDone === progress.unitsTotal);
    if (!force && !complete && now - last < 250) return;
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

/** Finish a live recording and keep what it has (cancel would discard it). */
export function stopJob(jobId: string): void {
  running.get(jobId)?.stop?.abort();
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

/**
 * Record a live or event stream (HLS or DASH dynamic): one file per track (video, and a separate audio when there is
 * one), then a stream copy into MP4 when the result fits the memory limit. Stop keeps what was recorded.
 */
async function recordLive(
  jobId: string,
  req: DownloadRequest,
  plan: OffscreenPlan,
  entry: Running,
  send: (p: JobProgress, force?: boolean) => void,
): Promise<void> {
  const { signal } = entry.abort;
  const stop = new AbortController();
  entry.stop = stop;
  const origins = req.credentialedOrigins ?? [];
  const urls = [req.sourceUrl, ...(req.audioUrl ? [req.audioUrl] : [])];
  const maxBytes = ((plan.recordMaxMb ?? 4096) * MB) / urls.length;
  const maxSeconds = (plan.recordMaxMinutes ?? 120) * 60;
  const seen = urls.map(() => ({ seconds: 0, bytes: 0, gaps: 0 }));
  stage(jobId, 'recording');
  const tracks = urls.map((url, i) =>
    recordLiveTrack({
      jobId,
      fileName: (frag) => `${i === 0 ? 'video' : 'audio'}.${frag ? 'mp4' : 'ts'}`,
      source: req.isDash
        ? dashLiveSource(url, signal, origins, { pageUrl: req.pageUrl, owner: url })
        : hlsLiveSource(url, signal, origins, { pageUrl: req.pageUrl, owner: url }),
      concurrency: plan.segmentConcurrency,
      credentialedOrigins: origins,
      net: { pageUrl: req.pageUrl, owner: url },
      signal,
      stop: stop.signal,
      onLimit: () => stop.abort(),
      maxSeconds,
      maxBytes,
      onProgress: (p) => {
        seen[i] = p;
        send({ ...liveProgress(seen), elapsedSec: Math.max(...seen.map((t) => t.seconds)) });
      },
    }),
  );
  let results: LiveTrackResult[];
  try {
    results = await Promise.all(tracks);
  } catch (e) {
    stop.abort(); // the other track must not run on alone
    await Promise.allSettled(tracks);
    throw e;
  }
  stage(jobId, 'merging');
  const [main, audio] = results as [LiveTrackResult, LiveTrackResult | undefined];
  const gaps = results.reduce((n, r) => n + r.gaps, 0);
  const total = results.reduce((n, r) => n + r.bytes, 0);
  const hasVideo = req.hasVideo;
  const extension = hasVideo ? 'mp4' : 'm4a';
  let blob: Blob | undefined;
  if (total <= (plan.maxMemoryMb * MB) / 2) {
    try {
      const output = `out.${extension}`;
      const data = await runFfmpeg({
        inputs: audio ? [main.file, audio.file] : [main.file],
        output,
        signal,
        durationSec: Math.max(1, ...results.map((r) => r.seconds)),
        onProgress: (fraction) => send(fraction === undefined ? {} : { fraction }),
        args: (paths) =>
          buildFfmpegArgs({
            mode: hasVideo ? 'video-audio' : 'audio-only',
            extension,
            video: hasVideo ? 'copy' : 'none',
            audio: 'copy',
            videoPath: paths[0] as string,
            ...(paths[1] ? { audioPath: paths[1] } : {}),
            audioFormat: 'm4a',
            audioBitrate: 192,
            keepOffsets: paths.length > 1,
            output,
          }),
      });
      if (data.byteLength > 0)
        blob = new Blob([data as Uint8Array<ArrayBuffer>], {
          type: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
        });
    } catch (e) {
      if (asPipelineError(e) instanceof CancelledError) throw e;
      if (audio) throw e; // two tracks cannot be saved as one without the join
      log.warn('could not convert the recording, keeping it as recorded:', asPipelineError(e).message);
    }
  } else if (audio) {
    throw new PipelineError(
      'too-large',
      'The recording is too large to join its video and audio in memory: raise the memory limit in Settings',
    );
  }
  let outExtension = extension;
  if (!blob) {
    // The recording as the stream delivered it: TS, or fragmented MP4.
    outExtension = main.fragmented ? (hasVideo ? 'mp4' : 'm4a') : 'ts';
    blob = new Blob([main.file], { type: MIME_BY_EXTENSION[outExtension] ?? 'application/octet-stream' });
  }
  if (signal.aborted) throw new CancelledError();
  entry.blobUrl = URL.createObjectURL(blob);
  emit({
    channel: 'vdown-offscreen-event',
    type: 'ready',
    jobId,
    blobUrl: entry.blobUrl,
    bytes: blob.size,
    extension: outExtension,
    ...(gaps > 0 ? { gaps } : {}),
  });
}

/**
 * A staged file with the MIME type of what it holds. Files on disk (OPFS) carry no type, and Chrome then sniffs the
 * bytes: an MPEG-TS file looks like nothing it knows, becomes text/plain, and on Linux "video.ts" was saved as
 * "video.txt". The Blob only references the file; nothing is copied.
 */
export function typed(file: Blob, extension: string): Blob {
  const type =
    extension === 'zip' ? 'application/zip' : (MIME_BY_EXTENSION[extension] ?? 'application/octet-stream');
  return file.type === type ? file : new Blob([file], { type });
}

/** The file extension of a recorder's output type. */
export function recordingExtension(mime: string): string {
  const mp4 = /mp4/i.test(mime);
  if (mp4) return mime.startsWith('audio/') ? 'm4a' : 'mp4';
  return 'webm';
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
  // Two tracks can only become one file in FFmpeg's memory, so their download is capped there. A single stream is
  // downloaded to disk in full: if it is then too large to convert, it is saved as it is (see keepOriginal below).
  const maxBytes = plan.requiresFfmpeg && req.audioUrl !== undefined ? plan.maxMemoryMb * MB : undefined;
  const credentialedOrigins = req.credentialedOrigins ?? [];
  // A recording is not a download: its stage (RECORDING) starts when the page has begun to record.
  if (plan.pipeline !== 'record' && plan.pipeline !== 'live') stage(jobId, 'downloading');

  // A recording of a MediaStream: the page connects and streams the recorder's output as it is made.
  const recordStarted = Date.now();
  const recorded =
    plan.pipeline === 'record' && req.held
      ? expectRecording({
          jobId,
          tabId: req.tabId,
          frameId: req.held.frameId ?? 0,
          // the page stops itself at the user's limit; this is the hard stop in case it does not
          maxBytes: Math.ceil((plan.recordMaxMb ?? 4096) * MB * 1.05) + 16 * MB,
          signal,
          onStart: () => stage(jobId, 'recording'),
          onProgress: (bytes) => send({ bytesDone: bytes, elapsedSec: (Date.now() - recordStarted) / 1000 }),
        })
      : undefined;
  recorded?.catch(() => undefined);

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
    req.held && !req.capture && !req.record
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

  // Recording of a live stream: look at it until Stop, its end or a limit, then join the tracks with a stream copy.
  if (plan.pipeline === 'live') {
    await recordLive(jobId, req, plan, entry, send);
    return;
  }

  // Recording of a MediaStream: tidy the recorder's output with a stream copy (duration, index), within the memory limit.
  if (recorded) {
    const rec = await recorded;
    stage(jobId, 'merging');
    const extension = recordingExtension(rec.mime);
    let blob: Blob = new Blob([rec.file], { type: rec.mime.split(';')[0] ?? 'application/octet-stream' });
    if (rec.bytes <= (plan.maxMemoryMb * MB) / 2) {
      try {
        const output = `out.${extension}`;
        const hasVideo = rec.mime.startsWith('video/');
        const data = await runFfmpeg({
          inputs: [rec.file],
          output,
          signal,
          onProgress: (fraction) => send(fraction === undefined ? {} : { fraction }),
          args: (paths) =>
            buildFfmpegArgs({
              mode: hasVideo ? 'video-audio' : 'audio-only',
              extension,
              video: hasVideo ? 'copy' : 'none',
              audio: 'copy',
              videoPath: paths[0] as string,
              audioFormat: 'm4a',
              audioBitrate: 192,
              output,
            }),
        });
        if (data.byteLength > 0)
          blob = new Blob([data as Uint8Array<ArrayBuffer>], {
            type: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
          });
      } catch (e) {
        if (asPipelineError(e) instanceof CancelledError) throw e;
        // The recording itself is what matters: keep it as the recorder wrote it.
        log.warn('could not tidy the recording, keeping it as recorded:', asPipelineError(e).message);
      }
    }
    if (signal.aborted) throw new CancelledError();
    entry.blobUrl = URL.createObjectURL(blob);
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: entry.blobUrl,
      bytes: blob.size,
      extension,
    });
    return;
  }

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
    entry.blobUrl = URL.createObjectURL(typed(zipped.file, 'zip'));
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
        net: { pageUrl: req.pageUrl, owner: req.sourceUrl },
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
          net: { pageUrl: req.pageUrl, owner: req.audioUrl },
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
      net: { pageUrl: req.pageUrl, owner: req.sourceUrl },
      signal,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      onProgress: send,
    });
    videoFile = staged.file;
  }
  send({ fraction: 1 }, true);

  // 2. Concatenation needs no processing: hand the disk-backed file straight to Chrome.
  if (!plan.requiresFfmpeg) {
    entry.blobUrl = URL.createObjectURL(typed(videoFile, plan.extension));
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: entry.blobUrl,
      bytes: videoFile.size,
    });
    return;
  }

  // A single stream that cannot be converted in browser memory is saved as it was downloaded, with a note on the job.
  // The staged stream is named after what it holds (video.ts, or video.mp4 for fragmented MP4).
  const original = videoFile.name.split('.').pop() === 'mp4' ? 'mp4' : 'ts';
  const keepOriginal = () => {
    entry.blobUrl = URL.createObjectURL(typed(videoFile, original));
    emit({
      channel: 'vdown-offscreen-event',
      type: 'ready',
      jobId,
      blobUrl: entry.blobUrl,
      bytes: videoFile.size,
      extension: original,
      keptOriginal: true,
    });
  };
  const canKeep = !audioFile && (req.isHls || req.isDash === true);
  if (canKeep && videoFile.size > plan.maxMemoryMb * MB) {
    log.warn('too large to convert in browser memory: keeping the stream as downloaded');
    return keepOriginal();
  }

  // 3. FFmpeg: copy/merge ("merging") or audio re-encode ("encoding").
  const reencodes = plan.audio === 'transcode' || plan.video === 'transcode';
  stage(jobId, reencodes ? 'encoding' : 'merging');
  const output = `out.${plan.extension}`;
  const inputs = audioFile ? [videoFile, audioFile] : [videoFile];
  let data: Uint8Array;
  try {
    data = await runFfmpeg({
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
    if (data.byteLength === 0) throw new PipelineError('ffmpeg', 'FFmpeg produced an empty file');
  } catch (e) {
    if (signal.aborted || asPipelineError(e) instanceof CancelledError) throw new CancelledError();
    // The download is on disk: a conversion that fails (out of memory, an odd stream) still leaves a usable file.
    if (!canKeep) throw e;
    log.warn('conversion failed, keeping the stream as downloaded:', asPipelineError(e).message);
    return keepOriginal();
  }
  if (signal.aborted) throw new CancelledError();
  // The staged inputs are no longer needed; the result lives in memory until Chrome has saved it.
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
    type: MIME_BY_EXTENSION[plan.extension] ?? 'application/octet-stream',
  });
  entry.blobUrl = URL.createObjectURL(blob);
  emit({ channel: 'vdown-offscreen-event', type: 'ready', jobId, blobUrl: entry.blobUrl, bytes: blob.size });
}
