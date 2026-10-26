import { describe, expect, it } from 'vitest';
import { analyzeCandidates, type Fetcher } from '@/lib/analyze';
import { parseHls } from '@/lib/hls/parser';
import { buildRequest, defaultChoices, sanitizeRequest } from '@/lib/request';
import { isPrivateHost, mayExtensionFetch } from '@/lib/security';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { setTabState, getTabState } from '@/background/tabState';
import type { ProbeResult } from '@/lib/netprobe';
import { installFakeChrome } from './helpers/fake-chrome';
import { makeResource } from './helpers';
import { WIDEVINE } from './fixtures/hls';

describe('private-network targets (SSRF guard for extension-origin fetches)', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '172.31.255.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '[::1]',
    'printer.local',
    'nas',
    'db.internal',
    '0.0.0.0',
    'fd12::1',
  ])('%s is private', (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });
  it.each(['example.com', 'cdn.example.co.uk', '8.8.8.8', '172.32.0.1', '192.169.0.1', '11.0.0.1'])(
    '%s is public',
    (h) => {
      expect(isPrivateHost(h)).toBe(false);
    },
  );
  it('a public page cannot aim the extension at a private host; a private page may', () => {
    expect(mayExtensionFetch('http://192.168.0.1/x.m3u8', 'https://site.example/watch')).toBe(false);
    expect(mayExtensionFetch('http://localhost:9222/json', 'https://site.example/watch')).toBe(false);
    expect(mayExtensionFetch('https://cdn.example/x.m3u8', 'https://site.example/watch')).toBe(true);
    expect(mayExtensionFetch('http://192.168.0.5:8096/v.m3u8', 'http://192.168.0.5:8096/web')).toBe(true);
    expect(mayExtensionFetch('file:///etc/passwd', 'http://localhost/')).toBe(false);
  });
});

describe('credentials only go to the page origin', () => {
  const r = makeResource('https://cdn.example/a.mp4', { pageUrl: 'https://site.example/watch' });
  const base = buildRequest(r, DEFAULT_SETTINGS, defaultChoices(r, DEFAULT_SETTINGS));
  it("drops every credentialed origin except the page's own", () => {
    const out = sanitizeRequest({
      ...base,
      credentialedOrigins: ['https://site.example', 'http://192.168.0.1', 'https://cdn.example'],
    });
    expect(out?.credentialedOrigins).toEqual(['https://site.example']);
  });
});

describe('extension-less media URLs', () => {
  it('are not saved as ".unknown"/".unkno"; the MIME type decides, otherwise no extension', () => {
    const noMime = makeResource('https://cdn.example/videoplayback?id=5', {
      format: 'unknown',
      title: 'videoplayback',
    });
    const a = buildRequest(noMime, DEFAULT_SETTINGS, defaultChoices(noMime, DEFAULT_SETTINGS));
    expect(a.filename).not.toMatch(/unkno/);
    expect(a.filename).toMatch(/^videoplayback/);
    expect(sanitizeRequest(a)?.filename).not.toMatch(/unkno/);

    const webm = makeResource('https://cdn.example/videoplayback?id=5', {
      format: 'unknown',
      mimeType: 'video/webm',
      title: 'videoplayback',
    });
    const b = buildRequest(webm, DEFAULT_SETTINGS, defaultChoices(webm, DEFAULT_SETTINGS));
    expect(b.filename.endsWith('.webm')).toBe(true);
  });
});

describe('AES-128 key that cannot be fetched', () => {
  it('is protected/unsupported instead of failing after the first segment', () => {
    const noKey =
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="skd://abc"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n';
    const r = parseHls(noKey, 'https://a.com/p.m3u8');
    expect(r.ok && r.playlist.kind === 'hls-media' && r.playlist.hasDrm).toBe(true);
    expect(parseHls(WIDEVINE, 'https://a.com/p.m3u8')).toMatchObject({ ok: true });
  });
  it('records the key in effect at EXT-X-MAP (it also encrypts the init section)', () => {
    const t =
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x01\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n#EXT-X-ENDLIST\n';
    const r = parseHls(t, 'https://a.com/p.m3u8');
    expect(r.ok && r.playlist.kind === 'hls-media' && r.playlist.segments[0]?.map?.key).toMatchObject({
      method: 'AES-128',
      iv: '0x01',
    });
  });
});

describe('hostile playlists cannot blow up stored state', () => {
  const ctx = { tabId: 1, pageUrl: 'https://site.example/', pageTitle: 'T'.repeat(5000), now: 1 };
  it('caps audio tracks and text lengths', async () => {
    const media = Array.from(
      { length: 5000 },
      (_, i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="${'N'.repeat(500)}${i}",URI="a${i}.m3u8"`,
    ).join('\n');
    const master = `#EXTM3U\n${media}\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="g"\nv.m3u8\n`;
    const variant = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n';
    const ok = (text: string, url: string): ProbeResult => ({
      ok: true,
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      acceptRanges: false,
      finalUrl: url,
      text,
    });
    const f: Fetcher = {
      head: async () => ({ ok: false, kind: 'http', status: 404 }),
      text: async (u) => ok(u.endsWith('m.m3u8') ? master : variant, u),
    };
    const [res] = await analyzeCandidates(
      [{ url: 'https://site.example/m.m3u8', method: 'performance' }],
      ctx,
      f,
    );
    expect(res?.audioTracks.length).toBeLessThanOrEqual(50);
    expect(res?.audioTracks.every((a) => a.name.length <= 201)).toBe(true);
    expect(res?.title.length).toBeLessThanOrEqual(201);
    expect(res?.pageTitle.length).toBeLessThanOrEqual(201);
    expect(JSON.stringify(res).length).toBeLessThan(60_000);
  });
  it('setTabState shrinks an oversized state rather than failing the whole scan', async () => {
    installFakeChrome();
    const many = Array.from({ length: 400 }, (_, i) =>
      makeResource(`https://a.com/${i}.mp4`, { title: 'x'.repeat(5000) }),
    );
    await setTabState({
      tabId: 7,
      status: 'ready',
      pageUrl: 'https://a.com',
      pageTitle: '',
      resources: many,
      notes: { blobSources: 0, inaccessibleFrames: 0 },
      observing: false,
    });
    const stored = await getTabState(7);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(1_000_000);
    expect(stored?.resources.length).toBeGreaterThan(0);
  });
});
