import { describe, expect, it } from 'vitest';
import { SAMPLE_BYTES, dispositionName, probeHeaders } from '@/lib/netprobe';

describe('Content-Disposition file names', () => {
  it('reads quoted, bare and RFC 5987 names, preferring the encoded one', () => {
    expect(dispositionName('attachment; filename="clip.mp4"')).toBe('clip.mp4');
    expect(dispositionName('attachment; filename=clip.mp4; size=3')).toBe('clip.mp4');
    expect(dispositionName(`attachment; filename="x.bin"; filename*=UTF-8''Caff%C3%A8%20clip.mp4`)).toBe(
      'Caffè clip.mp4',
    );
    expect(dispositionName('inline')).toBeUndefined();
    expect(dispositionName(null)).toBeUndefined();
  });
});

/** A fetch that answers HEAD with `head` and GET with `get`, recording each request. */
function fakeFetch(head: Record<string, string>, get: () => Response) {
  const calls: Array<{ method: string; range?: string }> = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push({ method, ...(range ? { range } : {}) });
    return method === 'HEAD' ? new Response(null, { status: 200, headers: head }) : get();
  }) as typeof fetch;
  return { f, calls };
}

/** A body that never ends, like a script streaming a live video. */
function endless(): ReadableStream<Uint8Array> {
  let n = 0;
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(256).fill(n++ % 256));
    },
  });
}

describe('probeHeaders', () => {
  it('reads only headers when the declared type says what the file is', async () => {
    const { f, calls } = fakeFetch({ 'content-type': 'video/mp4', 'content-length': '10' }, () => {
      throw new Error('no GET expected');
    });
    const r = await probeHeaders('https://a.example/v.mp4', f);
    expect(r).toMatchObject({ ok: true, contentType: 'video/mp4', contentLength: 10 });
    expect(r.ok && r.sample).toBeUndefined();
    expect(calls).toEqual([{ method: 'HEAD' }]);
  });
  it('samples the first bytes of a vague answer, even from an endless stream, and keeps the disposition name', async () => {
    const { f, calls } = fakeFetch(
      { 'content-type': 'text/html; charset=UTF-8', 'content-disposition': 'inline; filename="live.mp4"' },
      () => new Response(endless(), { status: 200, headers: { 'content-type': 'video/mp4' } }),
    );
    const r = await probeHeaders('https://a.example/live.php', f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispositionName).toBe('live.mp4');
    expect(r.sample?.contentType).toBe('video/mp4');
    expect(r.sample?.bytes).toHaveLength(SAMPLE_BYTES);
    expect(calls).toEqual([{ method: 'HEAD' }, { method: 'GET', range: `bytes=0-${SAMPLE_BYTES - 1}` }]);
  });
  it('does not sample when asked not to', async () => {
    const { f, calls } = fakeFetch({ 'content-type': 'application/octet-stream' }, () => {
      throw new Error('no GET expected');
    });
    const r = await probeHeaders('https://a.example/get.php', f, 'omit', false);
    expect(r.ok && r.sample).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
