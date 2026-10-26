import { parseUrl } from './security';

/** Kinds of plain files besides audio/video: shown in their own tabs and downloaded as they are. */
export type FileKind = 'image' | 'document' | 'archive' | 'asset';

const IMAGE = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'heic',
  'heif',
]);
const DOCUMENT = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'txt',
  'csv',
  'epub',
  'md',
]);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso']);
const ASSET = new Set([
  'js',
  'mjs',
  'css',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'json',
  'xml',
  'wasm',
  'webmanifest',
]);

/** Kind by file extension (lower case, no dot). */
export function fileKindOfExtension(ext: string | undefined): FileKind | undefined {
  if (!ext) return undefined;
  if (IMAGE.has(ext)) return 'image';
  if (DOCUMENT.has(ext)) return 'document';
  if (ARCHIVE.has(ext)) return 'archive';
  if (ASSET.has(ext)) return 'asset';
  return undefined;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/epub+zip': 'epub',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-bzip2': 'bz2',
  'application/x-xz': 'xz',
  'application/zstd': 'zst',
  'application/x-iso9660-image': 'iso',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/x-javascript': 'js',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/wasm': 'wasm',
  'application/manifest+json': 'webmanifest',
};

const clean = (mime: string | undefined): string => mime?.split(';')[0]?.trim().toLowerCase() ?? '';

/** File extension for a MIME type, when it is one we know. */
export function extensionForMime(mime: string | undefined): string | undefined {
  return MIME_EXT[clean(mime)];
}

/** Kind by MIME type. Any image/* counts as an image, even a type not listed above. */
export function fileKindOfMime(mime: string | undefined): FileKind | undefined {
  const m = clean(mime);
  if (!m) return undefined;
  if (m.startsWith('image/')) return 'image';
  const ext = MIME_EXT[m];
  return ext ? fileKindOfExtension(ext) : m.startsWith('font/') ? 'asset' : undefined;
}

/** Lower-case extension of a URL's path ("" when there is none or it does not look like one). */
export function urlExtension(url: string): string {
  const u = parseUrl(url);
  if (!u) return '';
  const last = u.pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  const ext = dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/** The file name as the server names it, without extension and decoded: "photo-1" for ".../a/photo-1.jpg?x=1". */
export function fileStem(url: string): string {
  const u = parseUrl(url);
  if (!u) return '';
  let last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep it undecoded
  }
  return last.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
}

export const FILE_KINDS: readonly FileKind[] = ['image', 'document', 'archive', 'asset'];
export const isFileKind = (k: string): k is FileKind => (FILE_KINDS as readonly string[]).includes(k);
