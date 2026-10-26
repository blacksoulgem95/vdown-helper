import {
  DashExpandError,
  expandSegments,
  mainPeriodIndex,
  parseDash,
  protectionsOf,
} from '@/lib/dash/parser';
import { parseDashRef } from '@/lib/dash/ref';
import type { DashRepresentation } from '@/types/dash';
import type { HlsSegment } from '@/types/hls';
import { PipelineError } from './errors';
import {
  credentialsFor,
  fetchManifestText,
  stageSegmentList,
  type StagedMedia,
  type StageOptions,
} from './hls';

type Creds = ReturnType<typeof credentialsFor>;

/**
 * Fetch and validate a manifest, then list the segments of one representation (addressed as
 * `<manifest>#vdh-rep=<id>`). Nothing the UI claimed about the manifest is trusted. Live and encrypted
 * representations are refused.
 */
export async function loadDashRepresentation(
  refUrl: string,
  signal: AbortSignal,
  creds: Creds,
): Promise<{
  rep: DashRepresentation;
  segments: HlsSegment[];
  init?: HlsSegment['map'];
  durationSec: number;
}> {
  const ref = parseDashRef(refUrl);
  if (!ref) throw new PipelineError('invalid', 'Not a DASH representation reference');
  const { text, url } = await fetchManifestText(ref.manifestUrl, signal, creds);
  const parsed = parseDash(text, url);
  if (!parsed.ok) throw new PipelineError('invalid', `Manifest error: ${parsed.error.code}`);
  const m = parsed.manifest;
  if (m.type === 'dynamic') throw new PipelineError('invalid', 'Live streams cannot be downloaded');
  const period = m.periods[mainPeriodIndex(m)];
  const rep = period?.representations.find((r) => r.id === ref.repId);
  if (!period || !rep)
    throw new PipelineError('invalid', 'The representation no longer exists in the manifest');
  const prot = protectionsOf(rep.content === 'text' ? [rep] : period.representations);
  if (prot.drm || prot.clearKey) {
    throw new PipelineError('protected', 'This stream is encrypted and cannot be downloaded');
  }
  try {
    const expanded = expandSegments(m, period, rep);
    return { rep, ...expanded };
  } catch (e) {
    if (e instanceof DashExpandError) throw new PipelineError('invalid', e.message);
    throw e;
  }
}

/**
 * Download one DASH representation into a single fragmented-MP4 file: the initialization segment followed by every
 * media segment, in order.
 */
export async function stageDashRepresentation(
  opts: Omit<StageOptions, 'playlistUrl'> & { ref: string },
): Promise<StagedMedia> {
  const expanded = await loadDashRepresentation(
    opts.ref,
    opts.signal,
    credentialsFor(opts.credentialedOrigins),
  );
  return stageSegmentList({
    ...opts,
    segs: expanded.segments,
    fragmented: true,
    durationSec: expanded.durationSec,
  });
}
