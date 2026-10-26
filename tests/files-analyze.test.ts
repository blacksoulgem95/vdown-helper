import { describe, expect, it } from 'vitest';
import { analyzeCandidates, provisionalResources, type Fetcher } from '@/lib/analyze';
import { buildRequest, defaultChoices, planFromRequest, sanitizeRequest } from '@/lib/request';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import type { ProbeResult } from '@/lib/netprobe';
import type { RawCandidate } from '@/types/media';

const ctx = { tabId: 1, pageUrl: 'https://site.example/gallery', pageTitle: 'Gallery', now: 1 };
const head = (contentType: string, contentLength?: number): ProbeResult => ({
  ok: true,
  status: 200,
  contentType,
  acceptRanges: true,
  finalUrl: '',
  ...(contentLength ? { contentLength } : {}),
});
function fetcher(map: Record<string, ProbeResult>): Fetcher & { heads: string[] } {
  const heads: string[] = [];
  const get = async (url: string) => {
    heads.push(url);
    return map[url] ?? ({ ok: false, kind: 'http', status: 404 } as ProbeResult);
  };
  return { heads, head: get, text: get };
}
const file = (
  url: string,
  fileKind: RawCandidate['fileKind'],
  extra: Partial<RawCandidate> = {},
): RawCandidate => ({
  url,
  method: 'dom-image',
  fileKind,
  ...extra,
});

describe('plain files', () => {
  it('names an image as the server does, takes type and size from headers, keeps page-given dimensions', async () => {
    const url = 'https://cdn.example/photos/Summer%20Trip.v2.jpg?w=800';
    const [r] = await analyzeCandidates(
      [file(url, 'image', { width: 800, height: 600 })],
      ctx,
      fetcher({ [url]: head('image/jpeg', 123_456) }),
    );
    expect(r).toMatchObject({
      kind: 'image',
      ext: 'jpg',
      title: 'Summer Trip.v2',
      mediaType: 'unknown',
      sizeBytes: 123_456,
      width: 800,
      height: 600,
      mimeType: 'image/jpeg',
      downloadability: { status: 'downloadable', reason: 'ok' },
    });
  });

  it('takes the extension from the MIME type when the URL has none', async () => {
    const url = 'https://cdn.example/image?id=7';
    const [r] = await analyzeCandidates(
      [file(url, 'image')],
      ctx,
      fetcher({ [url]: head('image/webp', 10) }),
    );
    expect(r).toMatchObject({ ext: 'webp', title: 'image' });
  });

  it('classifies documents, archives and assets and reports dead links and web pages honestly', async () => {
    const f = fetcher({
      'https://s.example/a.pdf': head('application/pdf', 5000),
      'https://s.example/b.zip': head('application/zip', 9000),
      'https://s.example/c.woff2': head('font/woff2', 100),
      'https://s.example/d.jpg': head('text/html'),
    });
    const out = await analyzeCandidates(
      [
        file('https://s.example/a.pdf', 'document'),
        file('https://s.example/b.zip', 'archive'),
        file('https://s.example/c.woff2', 'asset'),
        file('https://s.example/d.jpg', 'image'),
        file('https://s.example/gone.png', 'image'),
      ],
      ctx,
      f,
    );
    expect(out.map((r) => [r.kind, r.ext, r.downloadability.status, r.downloadability.reason])).toEqual([
      ['document', 'pdf', 'downloadable', 'ok'],
      ['archive', 'zip', 'downloadable', 'ok'],
      ['asset', 'woff2', 'downloadable', 'ok'],
      ['image', 'jpg', 'unsupported', 'unsupported-format'],
      ['image', 'png', 'inaccessible', 'http-error'],
    ]);
  });

  it('a page may answer with HTML for a document (viewers do), that is allowed', async () => {
    const url = 'https://s.example/viewer.txt';
    const [r] = await analyzeCandidates([file(url, 'document')], ctx, fetcher({ [url]: head('text/html') }));
    expect(r?.downloadability.status).toBe('downloadable');
  });

  it('stops probing after the HEAD budget but still lists the rest, ready to download', async () => {
    const urls = Array.from({ length: 200 }, (_, i) => `https://s.example/i${i}.png`);
    const f = fetcher(Object.fromEntries(urls.map((u) => [u, head('image/png', 1)])));
    const out = await analyzeCandidates(
      urls.map((u) => file(u, 'image')),
      ctx,
      f,
    );
    expect(out).toHaveLength(200);
    expect(f.heads.length).toBe(150);
    expect(out.every((r) => r.downloadability.status === 'downloadable')).toBe(true);
  });

  it('keeps per-kind caps so media still gets analysed on a page full of images', async () => {
    const imgs = Array.from({ length: 400 }, (_, i) => file(`https://s.example/i${i}.png`, 'image'));
    const video: RawCandidate = { url: 'https://s.example/v.mp4', method: 'dom-element' };
    const out = await analyzeCandidates([...imgs, video], ctx, fetcher({}));
    expect(out.filter((r) => r.kind === 'image')).toHaveLength(300);
    expect(out.some((r) => r.url.endsWith('/v.mp4'))).toBe(true);
  });

  it('shows files with the right kind even before probing finishes', () => {
    const [r] = provisionalResources([file('https://s.example/a.pdf', 'document')], ctx);
    expect(r).toMatchObject({ kind: 'document', ext: 'pdf', title: 'a' });
  });

  it('uses the size the page already knows (Resource Timing) without a request', async () => {
    const url = 'https://site.example/a.css';
    const f = fetcher({});
    const out = await analyzeCandidates([file(url, 'asset', { sizeBytes: 2048 })], ctx, f);
    expect(out[0]?.sizeBytes).toBe(2048);
  });
});

describe('plain file requests', () => {
  const resource = async (url: string, kind: RawCandidate['fileKind'], mime: string) => {
    const [r] = await analyzeCandidates([file(url, kind)], ctx, fetcher({ [url]: head(mime, 10) }));
    return r!;
  };
  it('is a native download under the server file name, with its extension', async () => {
    const r = await resource('https://s.example/files/Quarterly%20Report.pdf', 'document', 'application/pdf');
    const req = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
    expect(req.filename).toBe('Quarterly Report.pdf');
    expect(req.file).toEqual({ kind: 'document' });
    expect(planFromRequest(req, { maxMemoryMb: 1, maxEncodeDurationSec: 1 })).toMatchObject({
      valid: true,
      pipeline: 'native',
      extension: 'pdf',
      requiresFfmpeg: false,
    });
  });
  it('never takes a path out of the name', async () => {
    const r = await resource('https://s.example/a/..%2F..%2Fevil.png', 'image', 'image/png');
    const req = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
    expect(req.filename).not.toMatch(/[\\/]/);
    expect(req.filename.endsWith('.png')).toBe(true);
  });
  it('survives sanitising, and drops an invented kind', async () => {
    const r = await resource('https://s.example/a.png', 'image', 'image/png');
    const req = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
    expect(sanitizeRequest(req)?.file).toEqual({ kind: 'image' });
    expect(sanitizeRequest({ ...req, file: { kind: 'exe' as 'image' } })?.file).toBeUndefined();
  });
});
