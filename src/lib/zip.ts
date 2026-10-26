import type { MediaResource } from '@/types/media';
import { sanitizeFilename, withExtension } from './security';

/** The most files one ZIP may hold. */
export const MAX_ZIP_ITEMS = 500;

export interface ZipItem {
  url: string;
  /** Name inside the archive: flat, sanitised, unique (case-insensitively, as extraction tools see it). */
  name: string;
  /** Kind of file, to decide whether compressing is worth it. */
  deflate: boolean;
}

/** Text-like files compress well; images, archives, fonts and PDFs are already compressed, so they are stored. */
const COMPRESSIBLE = new Set([
  'css',
  'js',
  'mjs',
  'json',
  'xml',
  'svg',
  'txt',
  'csv',
  'md',
  'wasm',
  'webmanifest',
  'rtf',
]);

export const shouldDeflate = (ext: string | undefined): boolean =>
  COMPRESSIBLE.has((ext ?? '').toLowerCase());

/**
 * Names for the entries of a ZIP: the file name as the server gives it, made safe, and made unique by " (2)", " (3)"
 * before the extension when two files share a name. Case-insensitive, because extraction tools on Windows and macOS are.
 */
export function zipEntryNames(items: ReadonlyArray<{ title: string; ext?: string }>): string[] {
  const taken = new Set<string>();
  return items.map((it) => {
    const ext = it.ext ?? '';
    const stem = sanitizeFilename(it.title, 'file', 120);
    let name = ext ? withExtension(stem, ext) : stem;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = ext ? withExtension(`${stem} (${n})`, ext) : `${stem} (${n})`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

/** Entries for the given resources (page-held data: and anything not downloadable are left out; the counts say how many). */
export function planZip(resources: readonly MediaResource[]): { items: ZipItem[]; left: number } {
  const usable = resources.filter((r) => !r.held && r.downloadability.status === 'downloadable');
  const picked = usable.slice(0, MAX_ZIP_ITEMS);
  const names = zipEntryNames(picked.map((r) => ({ title: r.title, ...(r.ext ? { ext: r.ext } : {}) })));
  return {
    items: picked.map((r, i) => ({ url: r.url, name: names[i] as string, deflate: shouldDeflate(r.ext) })),
    left: resources.length - picked.length,
  };
}
