/** Which files go in a ZIP and under which names. Implemented in Rust (`core/src/zip.rs`). */
import type { MediaResource } from '@/types/media';
import { core } from './core';

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
export const shouldDeflate = (ext: string | undefined): boolean => core.shouldDeflate(ext);

/**
 * Names for the entries of a ZIP: the file name as the server gives it, made safe, and made unique by " (2)", " (3)"
 * before the extension when two files share a name. Case-insensitive, because extraction tools on Windows and macOS are.
 */
export function zipEntryNames(items: ReadonlyArray<{ title: string; ext?: string }>): string[] {
  return core.zipEntryNames(items);
}

/** Entries for the given resources (page-held data: and anything not downloadable are left out; the counts say how many). */
export function planZip(resources: readonly MediaResource[]): { items: ZipItem[]; left: number } {
  return core.planZip(resources) as { items: ZipItem[]; left: number };
}
