import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mseVideos } from '@/content/capture';
import { heldBlobs, heldData, scan, scanAsync } from '@/content/scanner';
import { classifyCandidates } from '@/lib/classify';
import { pageDataCandidates, tagCandidates } from '@/background/pageData';
import type { ScanReport } from '@/types/media';

// The frame reads its own feeds and site API (content/metadata.ts); in the extension the background asks it to.
vi.mock('@/background/pageFetch', async () => {
  const { sameOriginText } = await import('@/content/metadata');
  return {
    pageSameOriginText: (_tab: number, _frame: number | undefined, url: string) => sameOriginText(url),
  };
});

/** What the background makes of a frame's report: the scanner reports raw facts, lib/classify decides what they are. */
function classify(r: ScanReport): ScanReport {
  const c = classifyCandidates(r.candidates);
  return {
    ...r,
    candidates: c.candidates,
    notes: { ...r.notes, blobSources: r.notes.blobSources + c.unreadableBlobs },
  };
}

function setBody(html: string) {
  document.body.innerHTML = html;
  document.title = 'Test page';
}

beforeEach(() => setBody(''));

describe('content scanner', () => {
  it('finds src, <source>, and anchors, resolving relative URLs', () => {
    setBody(`
      <video src="/media/a.mp4" title="My video"></video>
      <video><source src="b.webm" type="video/webm"><source src="c.m3u8"></video>
      <audio src="https://cdn.example.org/s.mp3"></audio>
      <a href="/files/d.mkv">Download D</a>
      <a href="/page.html">not media</a>`);
    const r = classify(scan());
    const byUrl = Object.fromEntries(r.candidates.map((c) => [new URL(c.url).pathname, c]));
    expect(Object.keys(byUrl).sort()).toEqual(
      ['/files/d.mkv', '/media/a.mp4', '/s.mp3', '/b.webm', '/c.m3u8'].sort(),
    );
    expect(byUrl['/media/a.mp4']).toMatchObject({
      method: 'dom-element',
      mediaType: 'video',
      title: 'My video',
    });
    expect(byUrl['/b.webm']).toMatchObject({ method: 'dom-source', mimeType: 'video/webm' });
    expect(byUrl['/s.mp3']?.mediaType).toBe('audio');
    expect(byUrl['/files/d.mkv']).toMatchObject({ method: 'dom-link', title: 'Download D' });
    expect(r.pageTitle).toBe('Test page');
  });

  it('finds subtitle and caption <track>s with language and label, and ignores other kinds', () => {
    setBody(`<video src="/v.mp4">
      <track kind="subtitles" src="/cc/en.vtt" srclang="en" label="English">
      <track src="/cc/it.vtt" srclang="it">
      <track kind="captions" src="/cc/cap.vtt">
      <track kind="chapters" src="/cc/chapters.vtt">
      <track kind="metadata" src="/cc/meta.vtt">
      <track kind="subtitles" src="data:text/vtt;base64,V0VCVlRU" srclang="fr">
    </video>`);
    const tracks = scan().candidates.filter((c) => c.method === 'dom-track');
    expect(tracks.map((c) => [new URL(c.url).pathname, c.language, c.title, c.role, c.mimeType])).toEqual([
      ['/cc/en.vtt', 'en', 'English', 'subtitle', 'text/vtt'],
      ['/cc/it.vtt', 'it', undefined, 'subtitle', 'text/vtt'],
      ['/cc/cap.vtt', undefined, undefined, 'subtitle', 'text/vtt'],
    ]);
  });

  it('counts blob: sources but never reports them as candidates', () => {
    setBody('<video src="blob:https://example.com/1234"></video>');
    const r = scan();
    expect(r.candidates).toHaveLength(0);
    expect(r.notes.blobSources).toBe(1);
  });

  it('ignores dangerous and non-http schemes', () => {
    setBody(`
      <video src="javascript:alert(1)"></video>
      <a href="data:text/html;base64,PHNjcmlwdD4=">x</a>
      <a href="data:application/octet-stream;base64,AAAA.mp4">x</a>
      <a href="file:///tmp/x.mp4">y</a>`);
    expect(scan().candidates).toHaveLength(0);
  });

  it('reports data: media as a label and a size, and keeps the data in the page', () => {
    const payload = 'A'.repeat(400);
    const url = `data:video/mp4;base64,${payload}`;
    setBody(
      `<video src="${url}" title="Inline"></video><audio><source src="data:audio/mpeg,%FF%FB%90"></audio>`,
    );
    const r = scan();
    expect(r.candidates).toHaveLength(2);
    const [video, audio] = r.candidates;
    expect(video).toMatchObject({
      method: 'dom-element',
      mimeType: 'video/mp4',
      title: 'Inline',
      held: { kind: 'data', bytes: 300 },
    });
    expect(video!.url).toMatch(/^data:video\/mp4;vdh=[0-9a-f]{8}$/);
    expect(audio).toMatchObject({ method: 'dom-source', held: { kind: 'data', bytes: 3 } });
    // nothing that leaves the page contains the payload
    expect(JSON.stringify(r)).not.toContain(payload);
    expect(heldData.get(video!.held!.id)).toBe(url);
  });

  it('ignores data: that is not media, is malformed, or comes in too large a number', () => {
    setBody(
      `<video src="data:image/png;base64,AAAA"></video><video src="data:video/mp4"></video>` +
        Array.from(
          { length: 50 },
          (_, i) => `<video src="data:video/mp4;base64,${'QUJD'.repeat(i + 1)}"></video>`,
        ).join(''),
    );
    const r = scan();
    expect(r.candidates.every((c) => c.held)).toBe(true);
    expect(r.candidates.length).toBe(40);
  });

  it('reads inside open shadow roots', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<video src="https://cdn.example.org/shadow.mp4"></video>';
    expect(scan().candidates.map((c) => c.url)).toContain('https://cdn.example.org/shadow.mp4');
  });

  it('reads same-origin iframes and reports unreadable ones', () => {
    setBody('<iframe id="f"></iframe>');
    const frame = document.getElementById('f') as HTMLIFrameElement;
    frame.contentDocument?.write('<video src="https://cdn.example.org/inner.mp4"></video>');
    expect(scan().candidates.map((c) => c.url)).toContain('https://cdn.example.org/inner.mp4');
  });

  it('does not modify the page', () => {
    const html = '<video src="/a.mp4"></video>';
    setBody(html);
    scan();
    expect(document.body.innerHTML).toBe(html);
  });

  it('caps the number of candidates', () => {
    setBody(Array.from({ length: 500 }, (_, i) => `<a href="/f${i}.mp4">x</a>`).join(''));
    expect(classify(scan()).candidates.length).toBeLessThanOrEqual(200);
  });

  describe('images, documents, archives and page assets', () => {
    const kinds = (r: ReturnType<typeof scan>) =>
      r.candidates
        .filter((c) => c.fileKind)
        .map((c) => [new URL(c.url).pathname, c.fileKind, c.method] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));

    it('lists images with their natural size, posters, icons and social images', () => {
      setBody(`
        <img id="a" src="/img/a.png" alt="A">
        <video poster="/img/poster.jpg" src="/v.mp4"></video>`);
      document.head.innerHTML = `
        <link rel="icon" href="/favicon.ico">
        <link rel="apple-touch-icon" href="/touch.png">
        <meta property="og:image" content="https://cdn.example/og.jpg">`;
      const img = document.getElementById('a') as HTMLImageElement;
      Object.defineProperty(img, 'naturalWidth', { value: 640 });
      Object.defineProperty(img, 'naturalHeight', { value: 480 });
      const r = scan();
      document.head.innerHTML = '';
      expect(kinds(r)).toEqual([
        ['/favicon.ico', 'image', 'dom-meta'],
        ['/img/a.png', 'image', 'dom-image'],
        ['/img/poster.jpg', 'image', 'dom-image'],
        ['/og.jpg', 'image', 'dom-meta'],
        ['/touch.png', 'image', 'dom-meta'],
      ]);
      expect(r.candidates.find((c) => c.url.endsWith('/img/a.png'))).toMatchObject({
        width: 640,
        height: 480,
      });
    });

    it('lists document and archive links, scripts, stylesheets and fonts; plain links are not files', () => {
      setBody(`
        <a href="/docs/report.PDF">r</a> <a href="/docs/data.csv?x=1">d</a> <a href="/dl/pack.zip">z</a>
        <a href="/page.html">p</a> <a href="/lib.js">js link</a> <a href="mailto:a@b.c">m</a>
        <script src="/app.js"></script><link rel="stylesheet" href="/site.css">
        <link rel="preload" as="font" href="/f.woff2">`);
      expect(kinds(classify(scan()))).toEqual([
        ['/app.js', 'asset', 'dom-element'],
        ['/dl/pack.zip', 'archive', 'dom-link'],
        ['/docs/data.csv', 'document', 'dom-link'],
        ['/docs/report.PDF', 'document', 'dom-link'],
        ['/f.woff2', 'asset', 'dom-element'],
        ['/site.css', 'asset', 'dom-element'],
      ]);
    });

    it('finds CSS background images through computed style, ignoring gradients', () => {
      setBody(`<div style="background-image:url('/bg/hero.jpg')"></div>
        <div style="background-image:linear-gradient(red, blue)"></div>
        <div style="background:url(/bg/other.webp), url(/bg/second.png)"></div>`);
      expect(kinds(scan()).map((k) => k[0])).toEqual(['/bg/hero.jpg', '/bg/other.webp', '/bg/second.png']);
    });

    it('keeps data: images that are big enough to matter, never the small icons', () => {
      const big = `data:image/png;base64,${'A'.repeat(4000)}`;
      setBody(`<img src="${big}"><img src="data:image/png;base64,AAAA">`);
      const r = scan();
      const images = r.candidates.filter((c) => c.fileKind === 'image');
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ held: { kind: 'data', bytes: 3000 }, mimeType: 'image/png' });
      expect(JSON.stringify(r)).not.toContain('AAAAAAAA');
    });

    it('caps each kind separately so images cannot crowd out media', () => {
      setBody(
        '<video src="/v.mp4"></video>' +
          Array.from({ length: 400 }, (_, i) => `<img src="/i/${i}.png">`).join(''),
      );
      const r = scan();
      expect(r.candidates.filter((c) => c.fileKind === 'image')).toHaveLength(300);
      expect(r.candidates.filter((c) => !c.fileKind)).toHaveLength(1);
    });
  });
});

describe('blob: sources (scanAsync)', () => {
  const realFetch = globalThis.fetch;
  const bytes = (...v: number[]) => Uint8Array.from(v);
  const respond = (map: Record<string, Blob | Error | 'hang'>) => {
    globalThis.fetch = (async (url: string) => {
      const v = map[url];
      if (v === 'hang') return new Promise(() => undefined);
      if (!v || v instanceof Error) throw v ?? new Error('not found');
      return { blob: async () => v };
    }) as unknown as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('lists a readable blob like a file, with its real size and type, and stops counting it as unreadable', async () => {
    const blob = new Blob([bytes(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0)], {
      type: 'video/mp4',
    });
    respond({ 'blob:https://example.com/a': blob });
    setBody('<video src="blob:https://example.com/a" title="Recorded"></video>');
    const sync = scan();
    expect(sync.candidates).toHaveLength(0); // the synchronous scan still never reports blobs
    expect(sync.notes.blobSources).toBe(1);
    const r = classify(await scanAsync());
    expect(r.notes.blobSources).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      method: 'dom-element',
      mimeType: 'video/mp4',
      mediaType: 'video',
      title: 'Recorded',
      held: { kind: 'blob', bytes: 16 },
    });
    expect(r.candidates[0]!.url).toMatch(/^data:application\/x-vdh-blob;vdh=[0-9a-f]{8}$/);
    expect(r.candidates[0]!.url).not.toContain('blob:');
    expect(heldBlobs.get(r.candidates[0]!.held!.id)).toBe(blob);
  });

  it('recognises the type of an untyped blob from its first bytes, and files an image under images', async () => {
    // Chrome answers fetch() of an untyped Blob with text/plain: that is not taken at its word
    const png = new Blob([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)], {
      type: 'text/plain',
    });
    respond({ 'blob:https://example.com/img': png });
    setBody('<img src="blob:https://example.com/img">');
    const r = classify(await scanAsync());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ mimeType: 'image/png', fileKind: 'image', method: 'dom-image' });
    expect(r.notes.blobSources).toBe(0); // an image blob was never counted as an unreadable media source
  });

  it('lists a media element whose blob cannot be read as a MediaSource video; leaves out unknown content', async () => {
    vi.useFakeTimers();
    respond({
      'blob:https://example.com/mse': new Error('not fetchable'),
      'blob:https://example.com/hang': 'hang',
      'blob:https://example.com/text': new Blob(['something else'], { type: 'application/x-unknown' }),
    });
    setBody(
      '<video src="blob:https://example.com/mse" title="Player"></video><video src="blob:https://example.com/hang"></video>' +
        '<video src="blob:https://example.com/text"></video><video src="blob:https://example.com/gone"></video>' +
        '<img src="blob:https://example.com/img-gone">',
    );
    const p = scanAsync();
    await vi.advanceTimersByTimeAsync(3000);
    const r = classify(await p);
    // three videos fed by something unreadable (MediaSource, hung read, revoked URL): listed for capture, without a URL
    const mse = r.candidates.filter((c) => c.held?.kind === 'mse');
    expect(mse).toHaveLength(3);
    expect(mse[0]).toMatchObject({
      method: 'dom-element',
      title: 'Player',
      mediaType: 'video',
      held: { kind: 'mse', bytes: 0 },
    });
    expect(mse[0]!.url).toMatch(/^data:application\/x-vdh-mse;vdh=[0-9a-f]{8}$/);
    expect(r.candidates.some((c) => c.fileKind === 'image')).toBe(false); // an unreadable image blob is not a player
    expect(r.notes.blobSources).toBe(1); // the readable but unrecognised one
    expect(mseVideos.size).toBe(3);
    for (const id of mse.map((c) => c.held!.id)) expect(mseVideos.get(id)).toBeInstanceOf(HTMLVideoElement);
  });

  it('still lists a real text file as a document', async () => {
    respond({ 'blob:https://example.com/t': new Blob(['hello, world\n'], { type: 'text/plain' }) });
    setBody('<a href="blob:https://example.com/t" download="n.txt">Notes</a>');
    const r = classify(await scanAsync());
    expect(r.candidates[0]).toMatchObject({ fileKind: 'document', mimeType: 'text/plain' });
  });

  it('reports one candidate for a blob the page references twice, and keeps only the latest scan', async () => {
    const a = new Blob([bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0)], { type: 'video/webm' });
    respond({ 'blob:https://example.com/a': a });
    setBody('<video src="blob:https://example.com/a"><source src="blob:https://example.com/a"></video>');
    const first = classify(await scanAsync());
    expect(first.candidates).toHaveLength(2); // two different detection methods, as for http sources
    expect(new Set(first.candidates.map((c) => c.held!.id)).size).toBe(1);
    setBody('');
    classify(await scanAsync());
    expect(heldBlobs.size).toBe(0);
  });

  it('lists a blob download link under its real type', async () => {
    const pdf = new Blob([bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37)], {
      type: 'application/pdf',
    });
    respond({ 'blob:https://example.com/doc': pdf });
    setBody('<a href="blob:https://example.com/doc" download="r.pdf">Report</a>');
    const r = classify(await scanAsync());
    expect(r.candidates[0]).toMatchObject({
      fileKind: 'document',
      mimeType: 'application/pdf',
      title: 'Report',
    });
  });
});

describe('metadata and open-site lookups', () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  const answer = (map: Record<string, unknown | string>) => {
    requested.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requested.push(`${url} credentials=${init?.credentials}`);
      const v = map[new URL(url).pathname];
      if (v === undefined) return new Response('nope', { status: 404 });
      const res = new Response(typeof v === 'string' ? v : JSON.stringify(v));
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
    history.pushState({}, '', '/');
  });

  it('lists what the page announces: Open Graph, JSON-LD and alternate links (method "metadata")', () => {
    setBody(`
      <meta property="og:title" content="Launch">
      <meta property="og:video" content="https://cdn.example/launch.mp4">
      <meta property="og:video:type" content="video/mp4">
      <script type="application/ld+json">{"@type":"VideoObject","name":"Launch 2","contentUrl":"/two.webm"}</script>
      <link rel="alternate" type="audio/mpeg" href="/talk.mp3">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">`);
    const meta = tagCandidates(scan()).candidates;
    expect(meta.map((c) => c.url)).toEqual([
      'https://cdn.example/launch.mp4',
      `${location.origin}/two.webm`,
      `${location.origin}/talk.mp3`,
    ]);
    expect(meta[0]).toMatchObject({ title: 'Launch', mimeType: 'video/mp4', mediaType: 'video' });
    expect(requested).toEqual([]); // the synchronous scan makes no request at all
  });

  it("asks a PeerTube-shaped page for its own video, anonymously and only on the page's origin", async () => {
    history.pushState({}, '', '/w/kkGMgK9ZtnKfYAgnEtQxbv');
    setBody('<p>watch</p>');
    answer({
      '/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv': {
        uuid: '9c9de5e8',
        name: 'Clip',
        duration: 10,
        files: [
          {
            resolution: { id: 720, label: '720p' },
            fileUrl: `${location.origin}/static/c-720.mp4`,
            width: 1280,
            height: 720,
          },
        ],
        streamingPlaylists: [],
      },
    });
    const found = await pageDataCandidates(1, await scanAsync());
    expect(requested).toEqual([`${location.origin}/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv credentials=omit`]);
    expect(found.filter((c) => c.method === 'site-api')).toMatchObject([
      { url: `${location.origin}/static/c-720.mp4`, title: 'Clip (720p)', mediaType: 'video', width: 1280 },
    ]);
  });

  it('reads a feed the page offers (same origin only) and lists its enclosures', async () => {
    setBody(
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml"><link rel="alternate" type="application/rss+xml" href="https://other.example/feed.xml">`,
    );
    answer({
      '/feed.xml': `<rss><channel><item><title>Ep</title><enclosure url="https://cdn.example/e.mp3" type="audio/mpeg"/></item></channel></rss>`,
    });
    const found = await pageDataCandidates(1, await scanAsync());
    expect(requested).toEqual([`${location.origin}/feed.xml credentials=omit`]); // the other origin is never contacted
    expect(found).toContainEqual(
      expect.objectContaining({ url: 'https://cdn.example/e.mp3', method: 'metadata', title: 'Ep' }),
    );
  });

  it('makes no request on an ordinary page, and ignores a site that answers wrongly or from elsewhere', async () => {
    setBody('<p>hello</p>');
    answer({});
    await pageDataCandidates(1, await scanAsync());
    expect(requested).toEqual([]);

    history.pushState({}, '', '/w/kkGMgK9ZtnKfYAgnEtQxbv');
    answer({ '/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv': 'not json' });
    expect((await pageDataCandidates(1, await scanAsync())).filter((c) => c.method === 'site-api')).toEqual(
      [],
    );
    answer({ '/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv': { uuid: 'x', name: 'n', files: [] } });
    expect((await pageDataCandidates(1, await scanAsync())).filter((c) => c.method === 'site-api')).toEqual(
      [],
    );
  });
});
