/**
 * Classifies the raw facts a page scanner reports (src/content/scanner.ts): which links are documents or archives,
 * which resource entries are files worth listing, and what a page-held blob is. The scanner carries no such logic, so
 * the shared core (filetypes, sniff) never has to load in the page.
 */
import type { RawCandidate } from '@/types/media';
import { fileKindOfExtension, fileKindOfMime, urlExtension } from './filetypes';
import { sniffMime } from './sniff';

export interface Classified {
  candidates: RawCandidate[];
  /** Blobs the scanner counted as readable that turned out to be nothing worth listing: unreadable again. */
  unreadableBlobs: number;
}

function strip(c: RawCandidate): RawCandidate {
  const { fileHint: _hint, initiator: _initiator, blobHead: _head, blobCounted: _counted, ...rest } = c;
  return rest;
}

export function classifyCandidates(cands: readonly RawCandidate[]): Classified {
  const out: RawCandidate[] = [];
  let unreadableBlobs = 0;
  for (const c of cands) {
    if (c.fileHint === 'link') {
      // Assets are not links people follow; documents and archives are.
      const kind = fileKindOfExtension(urlExtension(c.url));
      if (kind === 'document' || kind === 'archive') out.push({ ...strip(c), fileKind: kind });
      continue;
    }
    if (c.fileHint === 'resource') {
      const kind = fileKindOfExtension(urlExtension(c.url)) ?? (c.initiator === 'img' ? 'image' : undefined);
      if (kind) out.push({ ...strip(c), fileKind: kind });
      continue;
    }
    if (c.held?.kind === 'blob') {
      let mime = c.mimeType ?? '';
      if (c.blobHead) mime = sniffMime(Uint8Array.from(c.blobHead)) ?? mime;
      const isMedia = /^(video|audio)\//.test(mime);
      const kind = isMedia ? undefined : fileKindOfMime(mime);
      // only media, images, documents, archives and page assets are listed; anything else stays unreadable
      if (!isMedia && !kind) {
        if (c.blobCounted) unreadableBlobs++;
        continue;
      }
      out.push({ ...strip(c), mimeType: mime, ...(kind ? { fileKind: kind } : {}) });
      continue;
    }
    out.push(c.blobHead || c.blobCounted || c.fileHint || c.initiator ? strip(c) : c);
  }
  return { candidates: out, unreadableBlobs };
}
