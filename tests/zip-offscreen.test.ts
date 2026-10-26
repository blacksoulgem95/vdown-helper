import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRequest } from '@/types/download';

const written: Uint8Array[] = [];
let aborted = false;
let bytes = 0;
vi.mock('@/offscreen/opfs', () => ({
  createStageFile: async () => ({
    get bytes() {
      return bytes;
    },
    write: async (c: Uint8Array) => {
      written.push(c.slice());
      bytes += c.byteLength;
    },
    finish: async () => new File(written as BlobPart[], 'bundle.zip'),
    abort: async () => void (aborted = true),
  }),
}));

const bodies = new Map<string, Uint8Array | Error>();
const asked: Array<{ url: string; max: number | undefined }> = [];
vi.mock('@/offscreen/hls', () => ({
  credentialsFor: () => () => 'omit',
  getBytes: async (url: string, _s: AbortSignal, _c: unknown, _r: unknown, max?: number) => {
    asked.push({ url, max });
    const b = bodies.get(url);
    if (b instanceof Error) throw b;
    if (!b) throw new PipelineErrorCtor('http-error', 'HTTP 404');
    if (max !== undefined && b.byteLength > max) throw new PipelineErrorCtor('too-large', 'too big');
    return b;
  },
}));

import { PipelineError as PipelineErrorCtor } from '@/offscreen/errors';
import { buildZip } from '@/offscreen/zip';

const enc = (s: string) => new TextEncoder().encode(s);
const item = (n: string, deflate = false) => ({ url: `https://a.example/${n}`, name: n, deflate });
const req = (items: ReturnType<typeof item>[], left = 0): DownloadRequest =>
  ({ zip: { resourceIds: [], items, left }, credentialedOrigins: [] }) as unknown as DownloadRequest;
const noop = () => undefined;
const ac = () => new AbortController().signal;
const unzip = async (f: File) => unzipSync(new Uint8Array(await f.arrayBuffer()));

beforeEach(() => {
  written.length = 0;
  bodies.clear();
  asked.length = 0;
  aborted = false;
  bytes = 0;
});

describe('buildZip', () => {
  it('packs files in order, byte for byte, compressing only what asked for it', async () => {
    const text = enc('hello hello hello hello hello hello hello hello'.repeat(50));
    bodies.set('https://a.example/a.png', Uint8Array.from([1, 2, 3, 4]));
    bodies.set('https://a.example/b.css', text);
    const out = await buildZip('j', req([item('a.png'), item('b.css', true)]), 2048, ac(), noop);
    const files = await unzip(out.file);
    expect(Object.keys(files)).toEqual(['a.png', 'b.css']);
    expect([...files['a.png']!]).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(files['b.css'])).toBe(new TextDecoder().decode(text));
    expect(out.failed).toBe(0);
    // the compressible file really is smaller on disk than its content
    expect(out.bytes).toBeLessThan(text.byteLength);
  });

  it('skips a file that fails, names it in _not-saved.txt (with no URL), and still produces the archive', async () => {
    bodies.set('https://a.example/ok.txt', enc('ok'));
    const out = await buildZip('j', req([item('gone.pdf'), item('ok.txt')], 2), 2048, ac(), noop);
    const files = await unzip(out.file);
    expect(Object.keys(files).sort()).toEqual(['_not-saved.txt', 'ok.txt']);
    const note = new TextDecoder().decode(files['_not-saved.txt']);
    expect(note).toContain('gone.pdf (http-error)');
    expect(note).toContain('2 more selected file(s)');
    expect(note).not.toContain('https://');
    expect(out.failed).toBe(1);
  });

  it('fails when nothing at all could be added', async () => {
    await expect(buildZip('j', req([item('a'), item('b')]), 2048, ac(), noop)).rejects.toMatchObject({
      code: 'network',
    });
    expect(aborted).toBe(true);
  });

  it('never grows past the size limit: a file that no longer fits is left out and named, not truncated', async () => {
    const big = new Uint8Array(70 * 1024 * 1024);
    bodies.set('https://a.example/1.bin', big);
    bodies.set('https://a.example/2.bin', big);
    bodies.set('https://a.example/3.txt', enc('small'));
    // 128 MB limit: the first fits, the second does not, the small one still does
    const out = await buildZip('j', req([item('1.bin'), item('2.bin'), item('3.txt')]), 128, ac(), noop);
    const files = await unzip(out.file);
    expect(Object.keys(files).sort()).toEqual(['1.bin', '3.txt', '_not-saved.txt']);
    expect(new TextDecoder().decode(files['_not-saved.txt'])).toContain('2.bin (too-large)');
    expect(out.bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  });

  it('fails the job if the finished archive would still exceed the limit', async () => {
    // a store-only entry adds headers on top of the data, so data that exactly fills the room overshoots
    const exact = new Uint8Array(128 * 1024 * 1024 - 10);
    bodies.set('https://a.example/x.bin', exact);
    await expect(buildZip('j', req([item('x.bin')]), 128, ac(), noop)).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(aborted).toBe(true);
  });

  it('never asks for more than the room that is left, nor more than one file may hold', async () => {
    bodies.set('https://a.example/a', enc('x'));
    await buildZip('j', req([item('a')]), 128, ac(), noop);
    expect(asked[0]?.max).toBe(128 * 1024 * 1024);
    await buildZip('j', req([item('a')]), 8192, ac(), noop);
    expect(asked[1]?.max).toBe(256 * 1024 * 1024);
  });

  it('is cancelled cleanly', async () => {
    const c = new AbortController();
    bodies.set('https://a.example/a', enc('x'));
    c.abort();
    await expect(buildZip('j', req([item('a')]), 2048, c.signal, noop)).rejects.toMatchObject({
      name: 'CancelledError',
    });
    expect(aborted).toBe(true);
  });

  it('reports progress per file', async () => {
    bodies.set('https://a.example/a', enc('x'));
    bodies.set('https://a.example/b', enc('y'));
    const seen: number[] = [];
    await buildZip('j', req([item('a'), item('b')]), 2048, ac(), (p) => void seen.push(p.fraction ?? -1));
    expect(seen).toEqual([0.5, 1]);
  });

  it('refuses an empty job', async () => {
    await expect(buildZip('j', req([]), 2048, ac(), noop)).rejects.toMatchObject({ code: 'invalid' });
  });
});
