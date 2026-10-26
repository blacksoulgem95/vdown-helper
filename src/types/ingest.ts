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
  | { t: 'error'; message: string };

/** Offscreen document -> content script. */
export type IngestDown =
  { t: 'ready' } | { t: 'ack'; seq: number } | { t: 'done' } | { t: 'abort'; message: string };

/** Largest data: URL payload the extension will move (decoded). */
export const MAX_HELD_BYTES = 32 * 1024 * 1024;
/** Raw bytes per chunk (about 1.4 MB once base64-encoded). */
export const INGEST_CHUNK_BYTES = 1024 * 1024;
