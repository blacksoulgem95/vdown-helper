import type { JobProgress } from '@/types/download';
import type { HlsSegment } from '@/types/hls';
import { CancelledError, PipelineError } from './errors';
import { credentialsFor, loadMediaPlaylist, writeSegments, type SegmentSinkState } from './hls';
import { createStageFile } from './opfs';
import { pollDashRepresentation } from './dash';

/** One look at a live stream: what is listed now, whether it is over, and when to look again. */
export interface LivePoll {
  segments: HlsSegment[];
  ended: boolean;
  refreshSec: number;
  /** Segments carry an absolute media sequence, so a jump between two looks is a gap in the recording. */
  sequenced: boolean;
  fragmented: boolean;
}

export type LiveSource = () => Promise<LivePoll>;

export function hlsLiveSource(url: string, signal: AbortSignal, credentialedOrigins: string[]): LiveSource {
  const creds = credentialsFor(credentialedOrigins);
  return async () => {
    const p = await loadMediaPlaylist(url, signal, creds, true);
    return {
      segments: p.segments,
      ended: p.endList,
      refreshSec: Math.min(10, Math.max(1, (p.targetDuration ?? 4) / 2)),
      sequenced: true,
      fragmented: p.fragmented,
    };
  };
}

export function dashLiveSource(ref: string, signal: AbortSignal, credentialedOrigins: string[]): LiveSource {
  const creds = credentialsFor(credentialedOrigins);
  return async () => {
    const p = await pollDashRepresentation(ref, signal, creds);
    return { ...p, sequenced: false, fragmented: true };
  };
}

export interface LiveTrackOptions {
  jobId: string;
  /** Staged file name; may depend on whether the segments are fMP4. */
  fileName: (fragmented: boolean) => string;
  source: LiveSource;
  concurrency: number;
  credentialedOrigins: string[];
  /** Cancel: everything is discarded. */
  signal: AbortSignal;
  /** Stop: no more is fetched, and what has been recorded is kept. Aborted by the user or by a limit. */
  stop: AbortSignal;
  /** Called when this track reaches a limit, so the other tracks of the recording end as well. */
  onLimit: () => void;
  maxSeconds: number;
  maxBytes: number;
  onProgress: (p: { seconds: number; bytes: number; gaps: number }) => void;
}

export interface LiveTrackResult {
  file: File;
  bytes: number;
  seconds: number;
  gaps: number;
  fragmented: boolean;
  endedBy: 'user' | 'limit' | 'ended' | 'stalled';
}

/** Segments written per step: a Stop is honoured between steps, so a long backlog does not delay it. */
const STEP = 12;
/** Consecutive failed looks at the stream before the recording gives up (and keeps what it has). */
const MAX_POLL_FAILURES = 5;
/** No new media for this long ends the recording (what was recorded is kept). */
const STALL_MS = 60_000;
/** How many segment addresses are remembered to tell new segments from ones already recorded. */
const SEEN_CAP = 4000;

/** Wait, but wake up early when any of the signals is aborted. */
const sleep = (ms: number, ...signals: AbortSignal[]) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const wake = () => {
      clearTimeout(t);
      resolve();
    };
    for (const s of signals) {
      if (s.aborted) return wake();
      s.addEventListener('abort', wake, { once: true });
    }
  });

/**
 * Record one live track (a media playlist, or one DASH representation): look at the stream again and again, append
 * every segment not recorded yet to one file on disk, in order, until Stop, the end of the stream, a limit, or the
 * stream stops moving. A segment the server no longer has is a counted gap, not a failure.
 */
export async function recordLiveTrack(opts: LiveTrackOptions): Promise<LiveTrackResult> {
  const { signal, stop } = opts;
  const seen = new Set<string>();
  const order: string[] = [];
  const state: SegmentSinkState = { mapKey: '', skipped: 0, seconds: 0 };
  let out: Awaited<ReturnType<typeof createStageFile>> | undefined;
  let fragmented = false;
  let endedBy: LiveTrackResult['endedBy'] = 'user';
  let lastSeq: number | undefined;
  let gaps = 0;
  let failures = 0;
  let idleSec = 0;
  let progressedAt = Date.now();
  let lastSeconds = 0;

  const report = () =>
    opts.onProgress({ seconds: state.seconds ?? 0, bytes: out?.bytes ?? 0, gaps: gaps + state.skipped });

  try {
    while (!stop.aborted) {
      if (signal.aborted) throw new CancelledError();
      // Segments keep being listed but none can be had (the server dropped them all): nothing is being recorded.
      if (out && out.bytes > 0 && Date.now() - progressedAt > STALL_MS) {
        endedBy = 'stalled';
        break;
      }
      let poll: LivePoll;
      try {
        poll = await opts.source();
        failures = 0;
      } catch (e) {
        if (signal.aborted) throw new CancelledError();
        // A refused or broken stream before anything was recorded is an error; later it just ends the recording.
        if (e instanceof PipelineError && (e.code === 'protected' || e.code === 'invalid') && !out) throw e;
        if (++failures >= MAX_POLL_FAILURES) {
          if (!out || out.bytes === 0) throw e;
          endedBy = 'stalled';
          break;
        }
        await sleep(2000, stop, signal);
        continue;
      }
      if (!out) {
        fragmented = poll.fragmented;
        out = await createStageFile(opts.jobId, opts.fileName(fragmented));
      }
      const fresh = poll.segments.filter((s) => !seen.has(s.uri));
      if (fresh.length > 0) {
        idleSec = 0;
        // A jump in the media sequence between two looks means segments went by that were never fetched.
        const first = fresh[0] as HlsSegment;
        if (poll.sequenced && lastSeq !== undefined && first.sequence > lastSeq + 1)
          gaps += first.sequence - lastSeq - 1;
        for (const s of fresh) {
          seen.add(s.uri);
          order.push(s.uri);
        }
        while (order.length > SEEN_CAP) seen.delete(order.shift() as string);
        lastSeq = (fresh[fresh.length - 1] as HlsSegment).sequence;
        for (let i = 0; i < fresh.length && !stop.aborted; i += STEP) {
          await writeSegments(
            {
              jobId: opts.jobId,
              segs: fresh.slice(i, i + STEP),
              fragmented,
              durationSec: 0,
              concurrency: opts.concurrency,
              credentialedOrigins: opts.credentialedOrigins,
              signal,
              tolerateMissing: true,
              onProgress: () => undefined,
            },
            out,
            state,
          );
          report();
          if ((state.seconds ?? 0) > lastSeconds) {
            lastSeconds = state.seconds ?? 0;
            progressedAt = Date.now();
          }
          if ((state.seconds ?? 0) >= opts.maxSeconds || out.bytes >= opts.maxBytes) {
            endedBy = 'limit';
            opts.onLimit();
            break;
          }
        }
        if (endedBy === 'limit') break;
      } else {
        idleSec += poll.refreshSec;
      }
      if (poll.ended) {
        endedBy = 'ended';
        break;
      }
      // A stream that lists nothing new for a long time is over, or stuck: keep what was recorded.
      if (idleSec > Math.max(30, poll.refreshSec * 8)) {
        endedBy = 'stalled';
        break;
      }
      await sleep(poll.refreshSec * 1000, stop, signal);
    }
    if (signal.aborted) throw new CancelledError();
    if (!out || out.bytes === 0)
      throw new PipelineError('capture', 'The stream did not provide anything to record');
    const file = await out.finish();
    report();
    return {
      file,
      bytes: out.bytes,
      seconds: state.seconds ?? 0,
      gaps: gaps + state.skipped,
      fragmented,
      endedBy,
    };
  } catch (e) {
    await out?.abort();
    throw e;
  }
}

/** The state of the whole recording, for the queue: elapsed media time, size, and the gaps so far. */
export function liveProgress(tracks: Array<{ seconds: number; bytes: number; gaps: number }>): JobProgress {
  return {
    elapsedSec: Math.max(0, ...tracks.map((t) => t.seconds)),
    bytesDone: tracks.reduce((n, t) => n + t.bytes, 0),
  };
}
