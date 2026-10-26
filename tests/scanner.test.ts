import { beforeEach, describe, expect, it } from 'vitest';
import { scan } from '@/content/scanner';

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
    const r = scan();
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
      <a href="data:video/mp4;base64,AAAA.mp4">x</a>
      <a href="file:///tmp/x.mp4">y</a>`);
    expect(scan().candidates).toHaveLength(0);
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
    expect(scan().candidates.length).toBeLessThanOrEqual(200);
  });
});
