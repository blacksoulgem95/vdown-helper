import { heldLimit } from '@/types/ingest';

export interface DataUrlInfo {
  /** Lower-case media type, e.g. "video/mp4". */
  mime: string;
  base64: boolean;
  /** Decoded size in bytes (exact for base64 without whitespace, close otherwise). */
  bytes: number;
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/;

/**
 * Describe a data: URL without decoding it. Returns undefined for anything that is not a well-formed data: URL.
 * The payload is never copied or logged; only its length is looked at.
 */
export function inspectDataUrl(url: string): DataUrlInfo | undefined {
  if (!/^data:/i.test(url)) return undefined;
  const comma = url.indexOf(',');
  if (comma < 5 || comma > 300) return undefined;
  const header = url.slice(5, comma).split(';');
  const mime = (header[0] ?? '').trim().toLowerCase() || 'text/plain';
  if (!MIME.test(mime)) return undefined;
  const base64 = header.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
  const n = url.length - comma - 1;
  let bytes: number;
  if (base64) {
    let pad = 0;
    if (url.endsWith('==')) pad = 2;
    else if (url.endsWith('=')) pad = 1;
    bytes = Math.max(0, Math.floor((n * 3) / 4) - pad);
  } else {
    bytes = n - 2 * (url.slice(comma + 1).match(/%[0-9a-f]{2}/gi)?.length ?? 0);
  }
  return { mime, base64, bytes };
}

/** Stable short handle for a data: URL (FNV-1a over its head, tail and length): not a security hash. */
export function dataHandle(url: string): string {
  const sample = `${url.length}|${url.slice(0, 4096)}|${url.slice(-4096)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The harmless label that stands in for a data: URL everywhere a URL is expected (it carries no payload). */
export function dataLabel(mime: string, handle: string): string {
  return `data:${mime};vdh=${handle}`;
}

export const DATA_LABEL = /^data:[a-z0-9!#$&^_.+/-]{3,170};vdh=[a-f0-9]{8}$/;

export const isDataLabel = (url: string): boolean => DATA_LABEL.test(url);

export const exceedsHeldLimit = (bytes: number, kind: 'data' | 'blob' = 'data'): boolean =>
  bytes > heldLimit(kind);

/** Stand-in label for a blob: URL (its type is only known once the page has been asked). */
export const blobLabel = (handle: string): string => dataLabel('application/x-vdh-blob', handle);
