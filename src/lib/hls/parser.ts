/** HLS playlist classification and parsing. Implemented in Rust (`core/src/hls`), shared with the desktop app. */
import type { HlsParseResult, PlaylistClass } from '@/types/hls';
import { core } from '../core';

/**
 * Decide what kind of playlist-like document `text` is:
 *  - hls-master / hls-media: valid HLS markers present
 *  - m3u-plain: an ordinary M3U/M3U8 list (audio list, IPTV list) with no HLS semantics
 *  - dash: an MPEG-DASH MPD document
 *  - unsupported: anything else
 */
export function classifyPlaylist(text: string): PlaylistClass {
  return core.classifyPlaylist(text) as PlaylistClass;
}

/** Parse an HLS playlist. Never throws; failures are returned as typed errors. */
export function parseHls(text: string, url: string): HlsParseResult {
  return core.parseHls(text, url) as HlsParseResult;
}
