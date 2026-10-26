/**
 * Page-held bytes travel from the content script of the owning frame to the offscreen document over a
 * `chrome.runtime` port named `vdh-ingest:<jobId>`, in base64 chunks (extension messaging is JSON). Every chunk is
 * acknowledged before the next one is sent, so memory stays bounded on both sides.
 */
export const INGEST_PORT_PREFIX = 'vdh-ingest:';

/** Content script -> offscreen document. */
export type IngestUp =
  | { t: 'begin'; mime: string; total: number }
  | { t: 'chunk'; seq: number; b64: string }
  | { t: 'end'; chunks: number }
  /**
   * A capture (MSE recording): chunks of several SourceBuffers, in the order the player appended them, with no known
   * total. `track` names the SourceBuffer; the bytes are one append, exactly as the player gave them to the browser.
   */
  | { t: 'cbegin'; mime?: string }
  | { t: 'cchunk'; seq: number; track: string; b64: string; frac?: number }
  | { t: 'cend'; chunks: number }
  | { t: 'error'; message: string };

/** Offscreen document -> content script. */
export type IngestDown =
  { t: 'ready' } | { t: 'ack'; seq: number } | { t: 'done' } | { t: 'abort'; message: string };

/** Largest data: URL payload the extension will move (decoded). */
export const MAX_HELD_BYTES = 32 * 1024 * 1024;
/** Largest blob: the extension will move out of a page (it is streamed to disk, not held in memory). */
export const HELD_BLOB_LIMIT = 4 * 1024 * 1024 * 1024;
/** Raw bytes per chunk (about 5.6 MB once base64-encoded, far below the 64 MB message limit). */
export const INGEST_CHUNK_BYTES = 4 * 1024 * 1024;

/** Most SourceBuffers one capture may record. */
export const MAX_CAPTURE_TRACKS = 8;
/** Most chunks one capture may hold (a two-hour video in 2 s segments is about 7,200 per track). */
export const MAX_CAPTURE_CHUNKS = 100_000;

/** The most a held source of this kind may be. */
export const heldLimit = (kind: 'data' | 'blob' | 'mse' | 'stream'): number =>
  kind === 'data' ? MAX_HELD_BYTES : HELD_BLOB_LIMIT;
