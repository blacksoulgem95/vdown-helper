/**
 * What kind of file these first bytes are, by their magic numbers. Used for page-held blobs, whose declared type is
 * often empty or "application/octet-stream". Returns a MIME type, or undefined when nothing is recognised. Implemented in
 * Rust (`core/src/sniff.rs`), shared with the desktop app.
 */
import { core } from './core';

export function sniffMime(b: Uint8Array): string | undefined {
  return core.sniffMime(b);
}
