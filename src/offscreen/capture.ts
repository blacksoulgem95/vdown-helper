import { buildFfmpegArgs } from '@/lib/ffmpegArgs';
import type { Part, PartTrack } from '@/lib/mseParts';
import { planParts } from '@/lib/mseParts';
import type { JobProgress } from '@/types/download';
import type { CaptureIngest } from './ingest';
import { CancelledError, PipelineError } from './errors';
import { runFfmpeg } from './ffmpeg';
import { createStageFile } from './opfs';

const MP4_VIDEO = /^(avc1|avc3|hvc1|hev1|vp09|av01|mp4v)$/i;
const MP4_AUDIO = /^(mp4a|opus|ac-3|ec-3|flac|fLaC)$/i;
const WEBM_VIDEO = /^V_(VP8|VP9|AV1)$/;
const WEBM_AUDIO = /^A_(OPUS|VORBIS)$/;

/** The container a part is copied into: its own kind when the codecs fit it, Matroska (which takes anything) otherwise. */
export function containerFor(part: Part): 'mp4' | 'webm' | 'mkv' | 'm4a' | 'mka' {
  const v = part.video?.codec;
  const a = part.audio?.codec;
  if (!v) return a && MP4_AUDIO.test(a) && /^mp4a$/i.test(a) ? 'm4a' : 'mka';
  if (part.container === 'mp4') return MP4_VIDEO.test(v) && (!a || MP4_AUDIO.test(a)) ? 'mp4' : 'mkv';
  return WEBM_VIDEO.test(v) && (!a || WEBM_AUDIO.test(a)) ? 'webm' : 'mkv';
}

export interface AssembledPart {
  data: Uint8Array;
  extension: string;
}

const copyChunks = async (
  jobId: string,
  name: string,
  track: PartTrack,
  ingest: CaptureIngest,
  signal: AbortSignal,
) => {
  const out = await createStageFile(jobId, name);
  try {
    for (const c of track.chunks) {
      if (signal.aborted) throw new CancelledError();
      const src = ingest.files.get(c.track);
      if (!src) continue;
      await out.write(new Uint8Array(await src.slice(c.offset, c.offset + c.length).arrayBuffer()));
    }
    return await out.finish();
  } catch (e) {
    await out.abort();
    throw e;
  }
};

/**
 * Turn what a capture recorded into files: split into parts where the player changed quality, give each part its
 * initialisation segments and media segments in time order, and copy the streams into a container (no re-encoding).
 * All parts are produced before any is handed out, so none can be lost to the clean-up of another.
 */
export async function assembleCapture(opts: {
  jobId: string;
  ingest: CaptureIngest;
  signal: AbortSignal;
  /** Output budget (bytes) shared by all parts. */
  maxBytes: number;
  onProgress: (p: JobProgress) => void;
}): Promise<AssembledPart[]> {
  const plan = planParts(opts.ingest.metas);
  if (plan.parts.length === 0)
    throw new PipelineError('capture', 'The player did not append anything that could be saved');
  const out: AssembledPart[] = [];
  let total = 0;
  for (const part of plan.parts) {
    if (opts.signal.aborted) throw new CancelledError();
    const ext = containerFor(part);
    const inputExt = part.container === 'webm' ? 'webm' : 'mp4';
    const files: File[] = [];
    for (const t of part.tracks) {
      files.push(
        await copyChunks(opts.jobId, `p${part.index}-${t.role}.${inputExt}`, t, opts.ingest, opts.signal),
      );
    }
    const hasVideo = part.video !== undefined;
    const separateAudio = files.length > 1;
    const duration = Number.isFinite(part.endSec) ? part.endSec - part.startSec : undefined;
    const data = await runFfmpeg({
      inputs: files,
      output: `out.${ext}`,
      signal: opts.signal,
      ...(duration ? { durationSec: duration } : {}),
      onProgress: (fraction) =>
        opts.onProgress(
          fraction === undefined ? {} : { fraction: (part.index + fraction) / plan.parts.length },
        ),
      args: (paths) =>
        buildFfmpegArgs({
          mode: hasVideo ? 'video-audio' : 'audio-only',
          extension: ext,
          video: hasVideo ? 'copy' : 'none',
          audio: hasVideo && !separateAudio && !part.audio ? 'none' : 'copy',
          videoPath: paths[0] as string,
          ...(separateAudio ? { audioPath: paths[1] as string } : {}),
          audioFormat: 'm4a',
          audioBitrate: 192,
          output: `out.${ext}`,
        }),
    });
    if (data.byteLength === 0) throw new PipelineError('ffmpeg', 'FFmpeg produced an empty file');
    total += data.byteLength;
    if (total > opts.maxBytes)
      throw new PipelineError('too-large', 'The captured video is larger than the configured size limit');
    out.push({ data, extension: ext });
  }
  return out;
}
