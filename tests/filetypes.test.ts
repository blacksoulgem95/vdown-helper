import { describe, expect, it } from 'vitest';
import {
  extensionForMime,
  fileKindOfExtension,
  fileKindOfMime,
  fileStem,
  isFileKind,
  urlExtension,
} from '@/lib/filetypes';

describe('file kinds', () => {
  it('sorts extensions into images, documents, archives and page assets', () => {
    expect(['jpg', 'png', 'svg', 'webp', 'avif', 'gif'].map(fileKindOfExtension)).toEqual(
      Array(6).fill('image'),
    );
    expect(['pdf', 'docx', 'xlsx', 'epub', 'csv'].map(fileKindOfExtension)).toEqual(
      Array(5).fill('document'),
    );
    expect(['zip', 'rar', '7z', 'tar', 'gz', 'iso'].map(fileKindOfExtension)).toEqual(
      Array(6).fill('archive'),
    );
    expect(['js', 'css', 'woff2', 'ttf', 'json', 'wasm'].map(fileKindOfExtension)).toEqual(
      Array(6).fill('asset'),
    );
    for (const e of ['exe', 'mp4', 'html', 'php', '', undefined])
      expect(fileKindOfExtension(e)).toBeUndefined();
  });
  it('knows the kind and extension of a MIME type, ignoring parameters and case', () => {
    expect(fileKindOfMime('Image/JPEG; q=1')).toBe('image');
    expect(fileKindOfMime('image/x-something-new')).toBe('image');
    expect(fileKindOfMime('application/pdf')).toBe('document');
    expect(fileKindOfMime('application/x-zip-compressed')).toBe('archive');
    expect(fileKindOfMime('font/woff2')).toBe('asset');
    expect(fileKindOfMime('text/html')).toBeUndefined();
    expect(fileKindOfMime('video/mp4')).toBeUndefined();
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'docx',
    );
    expect(extensionForMime('text/html')).toBeUndefined();
  });
  it('reads the extension and stem from a URL', () => {
    expect(urlExtension('https://a.com/x/Photo.JPG?w=1#f')).toBe('jpg');
    expect(urlExtension('https://a.com/x/noext')).toBe('');
    expect(urlExtension('https://a.com/x/a.toolongextension')).toBe('');
    expect(fileStem('https://a.com/x/My%20Photo.v2.jpg?w=1')).toBe('My Photo.v2');
    expect(fileStem('https://a.com/x/%E0%A4%A.png')).toBe('%E0%A4%A');
    expect(fileStem('https://a.com/')).toBe('');
    expect(isFileKind('image')).toBe(true);
    expect(isFileKind('file')).toBe(false);
  });
});
