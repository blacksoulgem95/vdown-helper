import { assembleCues, decodeSubtitleBytes } from '@/lib/subtitleBytes';
import { formatSrt, formatVtt, toSrt } from '@/lib/subtitles';
import type { DownloadRequest, JobProgress } from '@/types/download';
import { loadDashRepresentation } from './dash';
import { CancelledError, PipelineError } from './errors';
import { credentialsFor, getBytes, loadMediaPlaylist } from './hls';

/** Subtitles are small: hard caps keep a hostile playlist from turning this into a download of something large. */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_PIECE_BYTES = 8 * 1024 * 1024;
const MAX_PIECES = 5_000;
const CONCURRENCY = 4;

export interface SubtitleResult {
  blob: Blob;
  extension: 'srt' | 'vtt' | 'ttml';
}

const MIME = { srt: 'application/x-subrip', vtt: 'text/vtt', ttml: 'application/ttml+xml' } as const;

/**
 * Produce the subtitle file for a request: a single document (kept as found, or converted to SRT) or a segmented
 * stream (HLS WebVTT / DASH text) whose pieces are joined into one cue list and written as WebVTT or SRT.
 */
export async function buildSubtitle(
  req: DownloadRequest,
  signal: AbortSignal,
  onProgress: (p: JobProgress) => void,
): Promise<SubtitleResult> {
  const output = req.subtitle?.output ?? 'original';
  const creds = credentialsFor(req.credentialedOrigins);
  const check = () => {
    if (signal.aborted) throw new CancelledError();
  };

  if (!req.isHls && !req.isDash) {
    const bytes = await getBytes(req.sourceUrl, signal, creds, undefined, MAX_DOCUMENT_BYTES);
    onProgress({ fraction: 1, bytesDone: bytes.byteLength });
    if (output === 'original') {
      const ext = req.sourceFormat === 'srt' || req.sourceFormat === 'ttml' ? req.sourceFormat : 'vtt';
      return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[ext] }), extension: ext };
    }
    const srt = toSrt(decodeSubtitleBytes(bytes));
    if (srt === undefined)
      throw new PipelineError('invalid', 'No subtitle cues could be read from this file');
    return { blob: new Blob([srt], { type: MIME.srt }), extension: 'srt' };
  }

  let uris: Array<{ uri: string; byteRange?: { offset: number; length: number } }>;
  if (req.isDash) {
    uris = (await loadDashRepresentation(req.sourceUrl, signal, creds)).segments;
  } else {
    uris = (await loadMediaPlaylist(req.sourceUrl, signal, creds)).segments;
  }
  if (uris.length === 0) throw new PipelineError('invalid', 'The subtitle stream has no segments');
  if (uris.length > MAX_PIECES)
    throw new PipelineError('invalid', 'The subtitle stream has too many segments');

  const pieces = new Array<Uint8Array>(uris.length);
  let next = 0;
  let done = 0;
  let bytes = 0;
  const worker = async () => {
    for (;;) {
      check();
      const i = next++;
      if (i >= uris.length) return;
      const seg = uris[i] as (typeof uris)[number];
      pieces[i] = await getBytes(seg.uri, signal, creds, seg.byteRange, MAX_PIECE_BYTES);
      bytes += pieces[i]!.byteLength;
      done++;
      onProgress({
        fraction: done / uris.length,
        unitsDone: done,
        unitsTotal: uris.length,
        bytesDone: bytes,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uris.length) }, worker));
  check();

  const cues = assembleCues(pieces);
  if (cues.length === 0) {
    throw new PipelineError('invalid', 'No subtitle cues could be read from this stream');
  }
  if (output === 'srt') return { blob: new Blob([formatSrt(cues)], { type: MIME.srt }), extension: 'srt' };
  return { blob: new Blob([formatVtt(cues)], { type: MIME.vtt }), extension: 'vtt' };
}
