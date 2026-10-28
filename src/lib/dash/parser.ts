/** MPEG-DASH manifests. Implemented in Rust (`core/src/dash`), shared with the desktop app. */
import type { HlsMap, HlsSegment } from '@/types/hls';
import type {
  DashManifest,
  DashParseResult,
  DashPeriod,
  DashProtectionSystem,
  DashRepresentation,
} from '@/types/dash';
import { core } from '../core';

/** ISO 8601 duration ("PT1H2M3.5S") in seconds. Years and months are approximations, as the DASH spec allows. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  return core.parseIsoDuration(value);
}

export function parseDash(text: string, url: string): DashParseResult {
  return core.parseDash(text, url) as DashParseResult;
}

/** The period that holds the main content: the longest one (ads and bumpers are short periods). */
export function mainPeriodIndex(m: DashManifest): number {
  return core.mainPeriodIndex(m);
}

export function periodDuration(m: DashManifest, p: DashPeriod): number | undefined {
  return core.periodDuration(m, p);
}

/** Fill in $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$; "$$" is a literal dollar sign. */
export function substitute(template: string, vars: Record<string, string | number>): string {
  return core.substitute(template, vars);
}

export interface ExpandedRepresentation {
  init?: HlsMap;
  segments: HlsSegment[];
  durationSec: number;
}

export class DashExpandError extends Error {}

/** Turn a representation's addressing into a flat, ordered list of absolute segment URLs. */
export function expandSegments(
  m: DashManifest,
  period: DashPeriod,
  rep: DashRepresentation,
  /** The clock of a dynamic manifest (ms since the epoch); defaults to now. */
  nowMs: number = Date.now(),
): ExpandedRepresentation {
  const r = core.expandSegments(m, period, rep, nowMs) as
    { ok: true; value: ExpandedRepresentation } | { ok: false; error: string };
  if (!r.ok) throw new DashExpandError(r.error);
  return r.value;
}

/** Everything needed to decide what to do with a protected manifest. */
export function protectionsOf(reps: DashRepresentation[]): {
  /** At least one non-ClearKey key system (or bare CENC with no key system we can use): refuse. */
  drm: boolean;
  /** Only ClearKey is declared. */
  clearKey: boolean;
  systems: DashProtectionSystem[];
} {
  return core.protectionsOf(reps) as { drm: boolean; clearKey: boolean; systems: DashProtectionSystem[] };
}
