import { describe, expect, it, vi } from 'vitest';

vi.mock('@/offscreen/opfs', () => ({ freeBytes: async () => undefined, createStageFile: async () => ({}) }));

import { credentialsFor, getBytes } from '@/offscreen/hls';

const PAGE = 'https://site.example/watch';
const granted = ['https://site.example', 'https://cdn.example'];

describe('cookies follow the manifest that names the URL (security review L2)', () => {
  it('sends them to a granted origin only when the listing manifest is on a granted origin too', () => {
    const own = credentialsFor(granted, { pageUrl: PAGE, owner: 'https://cdn.example/p.m3u8' });
    expect(own('https://site.example/seg.ts')).toBe('include');
    expect(own('https://cdn.example/seg.ts')).toBe('include');
    expect(own('https://other.example/seg.ts')).toBe('omit');
    // a third party's playlist naming a granted site's address
    const foreign = credentialsFor(granted, { pageUrl: PAGE, owner: 'https://attacker.example/p.m3u8' });
    expect(foreign('https://site.example/logout')).toBe('omit');
    expect(foreign('https://cdn.example/seg.ts')).toBe('omit');
  });
});

describe('private-network addresses named by a manifest (security review L1)', () => {
  const realFetch = globalThis.fetch;
  it('are not fetched on behalf of a public page, but are for a page on the same kind of host', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (u: string) => {
      calls.push(u);
      return new Response('ok');
    }) as unknown as typeof fetch;
    try {
      const signal = new AbortController().signal;
      const pub = credentialsFor(granted, { pageUrl: PAGE, owner: PAGE });
      for (const bad of [
        'http://127.0.0.1:8080/x',
        'http://192.168.1.1/x',
        'http://10.0.0.5/x',
        'http://printer.local/x',
        'http://localhost/x',
      ])
        await expect(getBytes(bad, signal, pub)).rejects.toMatchObject({ code: 'invalid' });
      expect(calls).toEqual([]);
      await expect(getBytes('https://cdn.example/x', signal, pub)).resolves.toBeInstanceOf(Uint8Array);
      const local = credentialsFor([], {
        pageUrl: 'http://127.0.0.1:3000/p',
        owner: 'http://127.0.0.1:3000/p',
      });
      await expect(getBytes('http://127.0.0.1:3000/x', signal, local)).resolves.toBeInstanceOf(Uint8Array);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
