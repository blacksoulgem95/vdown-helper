import {
  DashExpandError,
  expandSegments,
  mainPeriodIndex,
  parseDash,
  protectionsOf,
} from '@/lib/dash/parser';
import { parseDashRef } from '@/lib/dash/ref';
import { PipelineError } from './errors';
import {
  credentialsFor,
  fetchManifestText,
  stageSegmentList,
  type StagedMedia,
  type StageOptions,
} from './hls';

/**
 * Download one DASH representation (addressed as `<manifest>#vdh-rep=<id>`) into a single fragmented-MP4 file:
 * the initialization segment followed by every media segment, in order. The manifest is fetched and validated again
 * here: nothing the UI claimed about it is trusted.
 */
export async function stageDashRepresentation(
  opts: Omit<StageOptions, 'playlistUrl'> & { ref: string },
): Promise<StagedMedia> {
  const ref = parseDashRef(opts.ref);
  if (!ref) throw new PipelineError('invalid', 'Not a DASH representation reference');
  const creds = credentialsFor(opts.credentialedOrigins);
  const { text, url } = await fetchManifestText(ref.manifestUrl, opts.signal, creds);
  const parsed = parseDash(text, url);
  if (!parsed.ok) throw new PipelineError('invalid', `Manifest error: ${parsed.error.code}`);
  const m = parsed.manifest;
  if (m.type === 'dynamic') throw new PipelineError('invalid', 'Live streams cannot be downloaded');
  const period = m.periods[mainPeriodIndex(m)];
  const rep = period?.representations.find((r) => r.id === ref.repId);
  if (!period || !rep)
    throw new PipelineError('invalid', 'The representation no longer exists in the manifest');
  const prot = protectionsOf(period.representations);
  if (prot.drm || prot.clearKey) {
    throw new PipelineError('protected', 'This stream is encrypted and cannot be downloaded');
  }
  let expanded;
  try {
    expanded = expandSegments(m, period, rep);
  } catch (e) {
    if (e instanceof DashExpandError) throw new PipelineError('invalid', e.message);
    throw e;
  }
  return stageSegmentList({
    ...opts,
    segs: expanded.segments,
    fragmented: true,
    durationSec: expanded.durationSec,
  });
}
