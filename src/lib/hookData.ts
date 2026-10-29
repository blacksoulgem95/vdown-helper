import type { MediaResource, RawCandidate } from '@/types/media';
import { core } from './core';

/**
 * What the page hook (src/content/hook.ts, MAIN world) reports. Implemented in Rust (`core/src/hook_data.rs`). The page controls that world, so every field is
 * untrusted: it is validated and size-capped here before it becomes a candidate.
 */
export interface HookRequest {
  url: string;
  /** Response content type, when the page's own request got a response. */
  contentType?: string;
  via: 'fetch' | 'xhr';
}

export interface HookReport {
  requests: HookRequest[];
  /** Key systems the page asked for through EME (e.g. "com.widevine.alpha"). */
  emeKeySystems: string[];
  /** MediaSources the page created, by the blob: URL it gave its player, with their SourceBuffers. */
  mediaSources: HookMediaSource[];
}

export interface HookMediaSource {
  url: string;
  buffers: Array<{ id: string; mime: string }>;
}

export function isInteresting(req: HookRequest): boolean {
  return core.isInteresting(req);
}

/** Parse arbitrary data from the page into a clean report. Never throws. */
export function parseHookReport(raw: unknown): HookReport {
  return core.parseHookReport(raw) as HookReport;
}

/** Candidates for the interesting requests, deduplicated by normalised URL. */
export function hookCandidates(
  report: HookReport,
  frame: { frameId?: number; frameUrl?: string },
): RawCandidate[] {
  return core.hookCandidates(report, frame.frameId, frame.frameUrl) as RawCandidate[];
}

/** Key systems that mean the stream is protected. ClearKey delivers its key in the clear and is not DRM. */
export function protectedKeySystems(systems: string[]): string[] {
  return core.protectedKeySystems(systems);
}

/** The resources with the new verdicts the core gave (`null`: unchanged). */
function withVerdicts(
  resources: MediaResource[],
  verdicts: Array<MediaResource['downloadability'] | null>,
): MediaResource[] {
  return resources.map((r, i) => {
    const d = verdicts[i];
    return d ? { ...r, downloadability: d } : r;
  });
}

/**
 * Resources found in a frame whose page asked for a DRM key system are protected: refuse them, whatever their
 * container says. (The page's player will be decrypting them with a licence we neither can nor will obtain.)
 */
export function markProtectedFrames(
  resources: MediaResource[],
  protectedByFrame: Map<number, string[]>,
): MediaResource[] {
  if (protectedByFrame.size === 0) return resources;
  return withVerdicts(resources, core.protectedFrameVerdicts(resources, [...protectedByFrame]));
}

/** Why the page hook has nothing to say about a frame: switched off, not allowed on that site, or there too late. */
export type MseMissing = 'mse-needs-hook' | 'mse-needs-access' | 'mse-needs-reload';

export function mseMissingReason(hookOn: boolean, siteAllowed: boolean): MseMissing {
  return core.mseMissingReason(hookOn, siteAllowed) as MseMissing;
}

/**
 * Decide whether a MediaSource player (`held.kind === 'mse'`) can be captured, from what the page hook of its own
 * frame saw. Without the hook there is no way to know how the player is fed; `missing` says why it is not there.
 */
export function markMseResources(
  resources: MediaResource[],
  reports: Map<number, HookReport>,
  missing: ReadonlyMap<number, MseMissing> = new Map(),
): MediaResource[] {
  return withVerdicts(resources, core.mseVerdicts(resources, [...reports], [...missing]));
}
