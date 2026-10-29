/** Kinds of plain files besides audio/video. Implemented in Rust (`core/src/filetypes.rs`), shared with the desktop app. */
import { core } from './core';

/** Kinds of plain files besides audio/video: shown in their own tabs and downloaded as they are. */
export type FileKind = 'image' | 'document' | 'archive' | 'asset';

/** Kind by file extension (lower case, no dot). */
export function fileKindOfExtension(ext: string | undefined): FileKind | undefined {
  return core.fileKindOfExtension(ext) as FileKind | undefined;
}

/** File extension for a MIME type, when it is one we know. */
export function extensionForMime(mime: string | undefined): string | undefined {
  return core.extensionForMime(mime);
}

/** Kind by MIME type. Any image/* counts as an image, even a type not listed. */
export function fileKindOfMime(mime: string | undefined): FileKind | undefined {
  return core.fileKindOfMime(mime) as FileKind | undefined;
}

/** Lower-case extension of a URL's path ("" when there is none or it does not look like one). */
export function urlExtension(url: string): string {
  return core.urlExtension(url);
}

/** The file name as the server names it, without extension and decoded: "photo-1" for ".../a/photo-1.jpg?x=1". */
export function fileStem(url: string): string {
  return core.fileStem(url);
}

export const FILE_KINDS: readonly FileKind[] = ['image', 'document', 'archive', 'asset'];
export const isFileKind = (k: string): k is FileKind => (FILE_KINDS as readonly string[]).includes(k);
