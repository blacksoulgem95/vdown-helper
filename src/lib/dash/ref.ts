/**
 * A DASH manifest holds many representations behind one URL. Wherever the app passes "a URL" around (variants,
 * audio tracks, requests) a representation is addressed as `<manifest url>#vdh-rep=<id>`. The fragment is never sent
 * to a server, so the URL stays a valid, safe http(s) URL everywhere else. Implemented in Rust (`core/src/dash/refs.rs`).
 */
import { core } from '../core';

export function dashRef(manifestUrl: string, repId: string): string {
  return core.dashRef(manifestUrl, repId);
}

export function parseDashRef(url: string): { manifestUrl: string; repId: string } | undefined {
  return core.parseDashRef(url) as { manifestUrl: string; repId: string } | undefined;
}
