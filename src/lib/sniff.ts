/**
 * What kind of file these first bytes are, by their magic numbers. Used for page-held blobs, whose declared type is
 * often empty or "application/octet-stream". Returns a MIME type, or undefined when nothing is recognised: the bytes
 * are only ever compared, never interpreted.
 */
const ascii = (b: Uint8Array, from: number, len: number): string =>
  String.fromCharCode(...b.subarray(from, from + len));

const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v);

export function sniffMime(b: Uint8Array): string | undefined {
  if (b.length < 4) return undefined;
  const head = ascii(b, 0, 4);
  // ISO base media: "ftyp" at offset 4, the brand says what it is
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    if (brand.startsWith('3g')) return 'video/3gpp';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    return 'video/mp4';
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(b, 0, Math.min(b.length, 64)).includes('matroska') ? 'video/x-matroska' : 'video/webm';
  }
  if (head === 'OggS') return 'audio/ogg';
  if (head === 'fLaC') return 'audio/flac';
  if (head === 'FLV\u0001') return 'video/x-flv';
  if (head === 'RIFF' && b.length >= 12) {
    const kind = ascii(b, 8, 4);
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
    if (kind === 'WEBP') return 'image/webp';
  }
  if (head === 'FORM' && b.length >= 12 && ascii(b, 8, 4).startsWith('AIF')) return 'audio/aiff';
  if (head.startsWith('ID3')) return 'audio/mpeg';
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0) return 'audio/mpeg';
  if (b[0] === 0x47 && b.length >= 376 && b[188] === 0x47 && b[376] === 0x47) return 'video/mp2t';
  if (startsWith(b, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return 'video/x-ms-asf';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('BM') && b.length > 14) return 'image/bmp';
  if (startsWith(b, [0, 0, 1, 0])) return 'image/x-icon';
  if (head === '%PDF') return 'application/pdf';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(b, [0x1f, 0x8b])) return 'application/gzip';
  if (head === 'Rar!') return 'application/vnd.rar';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  const text = ascii(b, 0, Math.min(b.length, 64))
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (text.startsWith('WEBVTT')) return 'text/vtt';
  if (/^<svg[\s>]|^<\?xml[\s\S]*<svg/i.test(text)) return 'image/svg+xml';
  return undefined;
}
