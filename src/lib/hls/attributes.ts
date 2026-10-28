/** HLS attribute lists. Implemented in Rust (`core/src/hls/attributes.rs`), shared with the desktop app. */
import { core } from '../core';

/** Parser for HLS attribute lists, e.g. BANDWIDTH=1000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720 */
export function parseAttributes(input: string): Record<string, string> {
  return core.parseAttributes(input) as Record<string, string>;
}
