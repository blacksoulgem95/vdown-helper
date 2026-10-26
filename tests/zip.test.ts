import { describe, expect, it } from 'vitest';
import { MAX_ZIP_ITEMS, planZip, shouldDeflate, zipEntryNames } from '@/lib/zip';
import { makeResource } from './helpers';

describe('zipEntryNames', () => {
  it('keeps names as given, with the extension, and makes duplicates unique before the extension', () => {
    expect(
      zipEntryNames([
        { title: 'photo', ext: 'jpg' },
        { title: 'photo', ext: 'jpg' },
        { title: 'photo', ext: 'jpg' },
        { title: 'photo', ext: 'png' },
        { title: 'notes' },
        { title: 'notes' },
      ]),
    ).toEqual(['photo.jpg', 'photo (2).jpg', 'photo (3).jpg', 'photo.png', 'notes', 'notes (2)']);
  });
  it('treats names that differ only by case as the same file', () => {
    expect(
      zipEntryNames([
        { title: 'Report', ext: 'pdf' },
        { title: 'report', ext: 'PDF' },
      ]),
    ).toEqual(['Report.pdf', 'report (2).pdf']);
  });
  it('never produces a path, a hidden file or an unsafe name', () => {
    const names = zipEntryNames([
      { title: '../../etc/passwd', ext: 'txt' },
      { title: 'a/b\\c:d', ext: 'png' },
      { title: '.htaccess' },
      { title: '', ext: 'jpg' },
      { title: 'CON', ext: 'txt' },
    ]);
    for (const n of names) {
      expect(n).not.toMatch(/[\\/:]/);
      expect(n.startsWith('.')).toBe(false);
      expect(n.length).toBeGreaterThan(0);
    }
    expect(names[3]).toBe('file.jpg');
  });
  it('is stable when the same list is given twice', () => {
    const list = [
      { title: 'x', ext: 'a' },
      { title: 'x', ext: 'a' },
    ];
    expect(zipEntryNames(list)).toEqual(zipEntryNames(list));
  });
});

describe('compression choice', () => {
  it('deflates text-like files only', () => {
    for (const e of ['css', 'JS', 'json', 'svg', 'txt', 'csv']) expect(shouldDeflate(e)).toBe(true);
    for (const e of ['png', 'jpg', 'zip', 'pdf', 'woff2', 'mp4', undefined, ''])
      expect(shouldDeflate(e)).toBe(false);
  });
});

describe('planZip', () => {
  const file = (n: number, over = {}) =>
    makeResource(`https://a.example/f${n}.png`, {
      kind: 'image',
      title: `f${n}`,
      ext: 'png',
      downloadability: { status: 'downloadable', reason: 'ok' },
      ...over,
    });
  it('leaves out what cannot go in and says how many', () => {
    const list = [
      file(1),
      file(2, { downloadability: { status: 'inaccessible', reason: 'http-error' } }),
      file(3, { held: { kind: 'data', id: 'abcd1234', bytes: 5 } }),
      file(4),
    ];
    const { items, left } = planZip(list);
    expect(items.map((i) => i.name)).toEqual(['f1.png', 'f4.png']);
    expect(left).toBe(2);
  });
  it('is bounded', () => {
    const many = Array.from({ length: MAX_ZIP_ITEMS + 25 }, (_, i) => file(i));
    const { items, left } = planZip(many);
    expect(items).toHaveLength(MAX_ZIP_ITEMS);
    expect(left).toBe(25);
  });
});
