/** What a download of one playlist will contact and contain. Implemented in Rust (`core/src/inspect.rs`). */
import type { HlsMediaPlaylist } from '@/types/hls';
import type { VariantInspection } from '@/types/messages';
import type { DashManifest, DashPeriod, DashRepresentation } from '@/types/dash';
import { DashExpandError } from './dash/parser';
import { core } from './core';

/** Origins (scheme + host) that a download of this playlist will contact. Used for access checks. */
export function originsOf(urls: Iterable<string>, max = 24): string[] {
  return core.originsOf([...urls], max) as string[];
}

export function sampleByOrigin(urls: Iterable<string>, max = 24): Record<string, string> {
  return core.sampleByOrigin([...urls], max) as Record<string, string>;
}

export function inspectMediaPlaylist(p: HlsMediaPlaylist): VariantInspection {
  return core.inspectMediaPlaylist(p) as VariantInspection;
}

/** Summary of one DASH representation, shaped like the HLS one so the rest of the app treats them alike. */
export function inspectDashRepresentation(
  m: DashManifest,
  period: DashPeriod,
  rep: DashRepresentation,
  /** The clock of a dynamic manifest (ms since the epoch); defaults to now. */
  nowMs: number = Date.now(),
): VariantInspection {
  const r = core.inspectDashRepresentation(m, period, rep, nowMs) as
    { ok: true; value: VariantInspection } | { ok: false; error: string };
  if (!r.ok) throw new DashExpandError(r.error);
  return r.value;
}
